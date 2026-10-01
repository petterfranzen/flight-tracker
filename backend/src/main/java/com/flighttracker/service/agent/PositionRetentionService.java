package com.flighttracker.service.agent;

import com.flighttracker.repository.AircraftRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.event.ContextClosedEvent;
import org.springframework.context.event.EventListener;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;

/**
 * Rolling retention for flight_position, the one table in this schema that
 * grows without bound. The global sweep alone writes ~11.5k rows every 6
 * minutes whether or not anyone is watching — ~2.76M rows/day — and until
 * this existed nothing ever deleted a row (there was not a single DELETE
 * anywhere in the backend).
 *
 * Only flight_position is pruned by the batched DELETE below. `aircraft`
 * gets its own, much gentler prune (deleteStaleWithNoPositions, see that
 * method's own javadoc) rather than a blanket age cutoff, because it holds
 * the lazily-fetched, rate-limited-to-obtain dossier enrichment
 * (registration, model, operator, route, airport coordinates) — pruning it
 * on the same 72h window as flight_position would throw away exactly the
 * expensive rows to reclaim a few kilobytes, for an aircraft that might
 * fly again tomorrow. `airport` is static reference data with no timestamp
 * to prune on at all.
 *
 * Cloud migration A2 (PLAN.md §6 item 6): 24h -> 72h retention (see
 * application.yml's flighttracker.retention.hours for the updated
 * reasoning), `ctid`-based batch deletes -> `id IN (SELECT id ... LIMIT ?)`
 * (SQLite has no `ctid`, and no `DELETE ... LIMIT` either — that's a
 * compile-time flag, not available here), and a PRAGMA incremental_vacuum/
 * wal_checkpoint pass after every run plus a nightly PRAGMA optimize,
 * replacing Postgres's autovacuum tuning (schema.sql's old
 * autovacuum_vacuum_scale_factor/threshold settings — gone now that
 * there's no autovacuum daemon to tune).
 *
 * Nothing routinely reads flight_position further back than the retention
 * window: the frontend's track trace asks for 6h (see FlightMap.tsx's
 * `from`), and /api/usage — the one endpoint that genuinely wanted deep
 * history — has no caller anywhere in the frontend.
 */
@Service
public class PositionRetentionService {

    private static final Logger log = LoggerFactory.getLogger(PositionRetentionService.class);

    /**
     * Deleted in batches rather than one predicate-wide DELETE: a single
     * statement covering a full retention window is millions of rows in
     * one transaction, holding the single SQLite writer lock for its
     * whole duration — exactly what PLAN.md's "SQLite rules that bite"
     * warns against. Batching keeps each transaction short and bounded no
     * matter how far behind retention has fallen.
     *
     * `id IN (SELECT id ... LIMIT ?)`, not `DELETE ... LIMIT` — SQLite only
     * supports LIMIT on DELETE when compiled with SQLITE_ENABLE_UPDATE_DELETE_LIMIT,
     * which the bundled sqlite-jdbc driver isn't. ORDER BY observed_at in
     * the subselect (served by idx_position_observed_at) keeps each batch
     * deleting the oldest rows first, same intent as the old ctid-ordered
     * Postgres version, just without a physical-location shortcut SQLite
     * has no equivalent of.
     */
    private static final String DELETE_BATCH_SQL = """
        DELETE FROM flight_position
        WHERE id IN (
            SELECT id FROM flight_position
            WHERE observed_at < ?
            ORDER BY observed_at
            LIMIT ?
        )
        """;

    private final JdbcTemplate jdbcTemplate;
    private final AircraftRepository aircraftRepository;
    private final Clock clock;
    // Each batch commits on its own. Deliberately a TransactionTemplate
    // rather than a @Transactional method on this class: Spring's
    // @Transactional works through a proxy, so a self-invoked call from the
    // loop below would silently run with no transaction at all — the exact
    // trap PositionPersistenceService's own class javadoc documents.
    private final TransactionTemplate transactionTemplate;

    @Value("${flighttracker.retention.hours:72}")
    private double retentionHours;

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

    // Set on context close, which fires before the scheduler drains its
    // in-flight tasks (see spring.lifecycle.timeout-per-shutdown-phase in
    // application.yml). A run in progress finishes its current batch and
    // stops there instead of working through up to max-batches-per-run while
    // systemd's TimeoutStopSec counts down; the rest waits for the next boot.
    private volatile boolean stopping;

    // How long an aircraft with no remaining flight_position rows survives
    // in the `aircraft` table before its own dossier row is pruned too —
    // see AircraftRepository.deleteStaleWithNoPositions. Deliberately much
    // longer than flight_position's own retention window: this only fires
    // for an aircraft that hasn't been seen at all in a week, not one
    // whose positions simply aged out of the 72h window while it keeps flying.
    private static final Duration AIRCRAFT_STALE_AFTER = Duration.ofDays(7);

    public PositionRetentionService(JdbcTemplate jdbcTemplate,
                                     AircraftRepository aircraftRepository,
                                     TransactionTemplate transactionTemplate,
                                     Clock clock) {
        this.jdbcTemplate = jdbcTemplate;
        this.aircraftRepository = aircraftRepository;
        this.transactionTemplate = transactionTemplate;
        this.clock = clock;
    }

    /**
     * Every 10 minutes rather than daily: at steady state that's a bounded
     * number of rows per run instead of one multi-million-row purge, which
     * keeps each pass small and spreads the vacuum load evenly instead of
     * concentrating it into a single daily spike.
     */
    @Scheduled(fixedDelayString = "${flighttracker.retention.interval-ms:600000}",
               initialDelayString = "${flighttracker.retention.initial-delay-ms:60000}")
    public void prune() {
        Instant now = clock.instant();
        long cutoffMillis = now.minusMillis(Math.round(retentionHours * 3_600_000)).toEpochMilli();

        long start = System.nanoTime();
        int totalDeleted = 0;
        int batches = 0;
        boolean moreRemaining = false;

        while (batches < maxBatchesPerRun && !stopping) {
            Integer deleted = transactionTemplate.execute(status ->
                    jdbcTemplate.update(DELETE_BATCH_SQL, cutoffMillis, batchSize));
            batches++;
            totalDeleted += deleted == null ? 0 : deleted;
            // A short batch means the predicate is exhausted; a full one
            // means there is (probably) more behind it.
            if (deleted == null || deleted < batchSize) break;
            if (batches == maxBatchesPerRun || stopping) moreRemaining = true;
        }

        int staleAircraftDeleted = aircraftRepository.deleteStaleWithNoPositions(now.minus(AIRCRAFT_STALE_AFTER));

        if (totalDeleted > 0) {
            // Reclaims pages the DELETE above just freed, in small,
            // predictable steps (2000 pages at a time) rather than a full
            // blocking VACUUM — see schema.sql's own auto_vacuum=INCREMENTAL
            // comment. wal_checkpoint(TRUNCATE) then folds the WAL file
            // back into the main database file and truncates it, so a long
            // run doesn't leave the -wal file growing indefinitely between
            // checkpoints.
            jdbcTemplate.execute("PRAGMA incremental_vacuum(2000)");
            jdbcTemplate.execute("PRAGMA wal_checkpoint(TRUNCATE)");
        }

        if (totalDeleted == 0 && staleAircraftDeleted == 0) return;
        long ms = (System.nanoTime() - start) / 1_000_000;
        log.info("retention: deleted {} flight_position rows older than {}h and {} stale aircraft rows in {} batches ({} ms){}",
                totalDeleted, retentionHours, staleAircraftDeleted, batches, ms,
                moreRemaining ? (stopping ? " — stopped early for shutdown, more remaining"
                        : " — hit max-batches-per-run, more remaining for next cycle") : "");
    }

    @EventListener(ContextClosedEvent.class)
    void stopAfterCurrentBatch() {
        stopping = true;
    }

    /**
     * SQLite's own recommended maintenance pragma — reruns ANALYZE-like
     * statistics gathering and can improve query plans after a lot of
     * churn (this table sees ~2.76M writes and a matching number of
     * deletes/day). Cheap and safe to run regularly; nightly rather than
     * every retention cycle simply because there's no benefit to running
     * it every 10 minutes — the statistics it updates don't shift that fast.
     */
    @Scheduled(cron = "0 0 3 * * *")
    public void nightlyOptimize() {
        jdbcTemplate.execute("PRAGMA optimize");
        log.info("retention: nightly PRAGMA optimize complete");
    }
}
