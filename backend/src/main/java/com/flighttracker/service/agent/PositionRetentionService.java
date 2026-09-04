package com.flighttracker.service.agent;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Profile;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;

/**
 * Rolling retention for flight_position, the one table in this schema that
 * grows without bound. The global sweep alone writes ~11.5k rows every 6
 * minutes whether or not anyone is watching — ~2.76M rows/day, ~0.8 GB/day
 * including indexes — and until this existed nothing ever deleted a row
 * (there was not a single DELETE anywhere in the backend).
 *
 * Only flight_position is pruned. Every other table is either a singleton
 * the app can't start without (poll_window, viewport_state), static
 * reference data with no timestamp to prune on (airport), or a
 * one-row-per-aircraft projection that saturates at the size of the
 * observable fleet rather than growing (aircraft,
 * aircraft_latest_position). Two of those deserve spelling out, because
 * "delete everything older than 24h" sounds like it should apply to them
 * and would be actively harmful:
 *
 *  - `aircraft` holds the lazily-fetched dossier enrichment (registration,
 *    model, operator, route, airport coordinates). Only a small fraction
 *    of rows are ever enriched, and each of those cost a rate-limited
 *    OpenSky/adsbdb call that AircraftEnrichmentService goes to real
 *    lengths to avoid spending twice. Pruning it would throw away exactly
 *    the expensive rows to reclaim a couple of megabytes.
 *  - `aircraft_latest_position` is what the live map reads, and
 *    LiveVisibilityWindows deliberately keeps both airborne and landed
 *    aircraft visible for 48h — "a plane parked at the gate is exactly the
 *    case we want to keep showing". Deleting its rows at 24h would halve
 *    that window silently, changing map behaviour without touching the
 *    constant that documents it. If a shorter live window is ever wanted,
 *    change LiveVisibilityWindows; don't let retention do it as a side
 *    effect.
 *
 * Nothing routinely reads flight_position further back than the retention
 * window: the frontend's track trace asks for 6h (see FlightMap.tsx's
 * `from`), and /api/usage — the one endpoint that genuinely wanted deep
 * history — has no caller anywhere in the frontend.
 *
 * One accepted edge, spelled out because it's user-visible rather than
 * theoretical: findCurrentLegTakeoffTime walks an aircraft's history
 * backwards for the last ground->air transition. "No flight takes longer
 * than 24h" holds for airborne aircraft, but LiveVisibilityWindows keeps a
 * *landed* one on the map for 48h after touchdown, so an aircraft that
 * landed 30h ago can outlive its own takeoff row. That query already has a
 * defined fallback for a missing transition (its `prev_on_ground IS NULL`
 * branch) and returns the oldest surviving airborne row instead, so the
 * dossier understates flight time for such an aircraft rather than
 * erroring. Widening retention to 48h would close the gap at twice the
 * storage; it's deliberately not done, because the affected case is a
 * long-parked aircraft whose flight time is the least interesting thing
 * about it.
 */
@Service
@Profile("agent")
public class PositionRetentionService {

    private static final Logger log = LoggerFactory.getLogger(PositionRetentionService.class);

    /**
     * Deleted in batches rather than one predicate-wide DELETE: a single
     * statement covering a full day is ~2.76M rows in one transaction,
     * holding row locks and bloating WAL for its whole duration. Batching
     * keeps each transaction short and bounded no matter how far behind
     * retention has fallen.
     *
     * Matched on ctid, not id, and that distinction matters more than it
     * looks. The obvious `WHERE id IN (SELECT id ... LIMIT n)` plans as a
     * hash semi join whose outer side is a *sequential scan of the whole
     * table* — verified with EXPLAIN — so every batch would re-scan
     * everything and the cost of a run would grow with table size, exactly
     * backwards from what batching is for. Matching on ctid (the row's
     * physical location) instead gives a nested loop over a Tid Scan:
     * cost 1072 vs 5490 on a 178k-row table, and flat as the table grows,
     * because it touches only the rows the LIMIT actually selected.
     *
     * ctids are only stable within a snapshot, which is fine here — the
     * subselect and the delete are one statement, and retention is a
     * single writer (@Profile("agent"), one container).
     */
    private static final String DELETE_BATCH_SQL = """
        DELETE FROM flight_position
        WHERE ctid IN (
            SELECT ctid FROM flight_position
            WHERE observed_at < ?
            ORDER BY observed_at
            LIMIT ?
        )
        """;

    private final JdbcTemplate jdbcTemplate;
    // Each batch commits on its own. Deliberately a TransactionTemplate
    // rather than a @Transactional method on this class: Spring's
    // @Transactional works through a proxy, so a self-invoked call from the
    // loop below would silently run with no transaction at all — the exact
    // trap PositionPersistenceService's own class javadoc documents.
    private final TransactionTemplate transactionTemplate;

    @Value("${flighttracker.retention.hours:24}")
    private int retentionHours;

    @Value("${flighttracker.retention.batch-size:5000}")
    private int batchSize;

    /**
     * Bounds a single run regardless of how big the backlog is. The first
     * run against a database that has been accumulating since before
     * retention existed would otherwise loop for a very long time inside
     * one scheduled invocation; this lets it make steady progress across
     * several runs instead, and guarantees the scheduler thread comes back.
     */
    @Value("${flighttracker.retention.max-batches-per-run:200}")
    private int maxBatchesPerRun;

    public PositionRetentionService(JdbcTemplate jdbcTemplate, TransactionTemplate transactionTemplate) {
        this.jdbcTemplate = jdbcTemplate;
        this.transactionTemplate = transactionTemplate;
    }

    /**
     * Every 10 minutes rather than daily: at steady state that's ~19k rows
     * per run (10 minutes of sweep output) instead of one 2.76M-row purge,
     * which keeps each pass small and spreads the vacuum load evenly
     * instead of concentrating it into a single daily spike — the better
     * shape for a NAS with a modest I/O budget.
     */
    @Scheduled(fixedDelayString = "${flighttracker.retention.interval-ms:600000}",
               initialDelayString = "${flighttracker.retention.initial-delay-ms:60000}")
    public void prune() {
        Instant cutoff = Instant.now().minus(Duration.ofHours(retentionHours));
        Timestamp cutoffTs = Timestamp.from(cutoff);

        long start = System.nanoTime();
        int totalDeleted = 0;
        int batches = 0;
        boolean moreRemaining = false;

        while (batches < maxBatchesPerRun) {
            Integer deleted = transactionTemplate.execute(status ->
                    jdbcTemplate.update(DELETE_BATCH_SQL, cutoffTs, batchSize));
            batches++;
            totalDeleted += deleted == null ? 0 : deleted;
            // A short batch means the predicate is exhausted; a full one
            // means there is (probably) more behind it.
            if (deleted == null || deleted < batchSize) break;
            if (batches == maxBatchesPerRun) moreRemaining = true;
        }

        if (totalDeleted == 0) return;
        long ms = (System.nanoTime() - start) / 1_000_000;
        log.info("retention: deleted {} flight_position rows older than {}h in {} batches ({} ms){}",
                totalDeleted, retentionHours, batches, ms,
                moreRemaining ? " — hit max-batches-per-run, more remaining for next cycle" : "");
    }
}
