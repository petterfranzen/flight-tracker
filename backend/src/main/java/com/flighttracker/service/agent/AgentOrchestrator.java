package com.flighttracker.service.agent;

import com.flighttracker.service.PollWindowService;
import com.flighttracker.service.enrichment.AircraftEnrichmentService;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Profile;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Spring auto-injects every FlightDataAgent bean here — registering a new
 * agent is just adding a @Component that implements the interface, nothing
 * to wire up by hand. Each poll cycle fans out to all agents, normalises
 * their reports, and hands them to PositionPersistenceService to write.
 *
 * Only runs in the "agent" container — see PollWindowService and
 * PositionNotificationListener for how it coordinates with the "api"
 * container (poll-window state and the live WebSocket feed respectively)
 * now that they're separate processes.
 */
@Service
@Profile("agent")
public class AgentOrchestrator {

    private static final Logger log = LoggerFactory.getLogger(AgentOrchestrator.class);

    private final List<FlightDataAgent> agents;
    private final PositionPersistenceService persistenceService;
    private final AircraftEnrichmentService enrichmentService;
    private final PollWindowService pollWindowService;

    // Local-only, just to avoid a log line every poll cycle while the
    // window stays closed — the authoritative state is PollWindowService.
    private final AtomicBoolean windowOpenLastCycle = new AtomicBoolean(true);

    // Same idea as windowOpenLastCycle, for the global hot-poll call
    // budget — logged once when it's exhausted, not every cycle.
    private final AtomicBoolean budgetAvailableLastCycle = new AtomicBoolean(true);

    public AgentOrchestrator(List<FlightDataAgent> agents,
                              PositionPersistenceService persistenceService,
                              AircraftEnrichmentService enrichmentService,
                              PollWindowService pollWindowService) {
        this.agents = agents;
        this.persistenceService = persistenceService;
        this.enrichmentService = enrichmentService;
        this.pollWindowService = pollWindowService;
    }

    // Opens the window on every container boot, same as the old in-memory
    // default did — so a fresh deployment shows live traffic immediately
    // without needing the UI's restart button first.
    //
    // On a genuinely empty database (first-ever boot, or a fresh volume)
    // this also runs one global sweep synchronously before startup
    // completes — otherwise the map would show nothing worldwide until
    // the first scheduled sweep fires, up to global-sweep-interval-seconds
    // later. Deliberately skipped when the table already has *some* data
    // (an ordinary restart/redeploy): that data is still good enough to
    // show immediately, and blocking every single restart for the ~30s+ a
    // full-world sweep takes isn't worth it just to shave a few minutes of
    // staleness off data that already exists.
    @PostConstruct
    void seedOnStartup() {
        // bypassQuota: this is a boot-time call, not a request from
        // anyone — see PollWindowService.restart()'s javadoc.
        pollWindowService.restart(true);
        if (persistenceService.hasNoPositions()) {
            log.info("Database is empty — seeding with a global sweep before startup completes");
            runGlobalSweep();
        }
    }

    @Scheduled(fixedDelayString = "#{${flighttracker.agents.poll-interval-seconds} * 1000}")
    public void pollAll() {
        if (!pollWindowService.isActive()) {
            if (windowOpenLastCycle.compareAndSet(true, false)) {
                log.info("Polling window elapsed — stopped until restarted via POST /api/agents/restart");
            }
            return;
        }
        windowOpenLastCycle.set(true);

        // Independent of the poll window above: even while it's open, the
        // global hot-poll-daily-call-budget can still say no — see
        // PollWindowService.hotPollBudgetAvailable's javadoc. Falls back to
        // the always-on global sweep alone for the rest of that budget's
        // rolling 24h, same as if the window itself had simply never been
        // reopened.
        if (!pollWindowService.hotPollBudgetAvailable()) {
            if (budgetAvailableLastCycle.compareAndSet(true, false)) {
                log.warn("Global hot-poll call budget exhausted for today — falling back to the global sweep alone");
            }
            return;
        }
        budgetAvailableLastCycle.set(true);

        for (FlightDataAgent agent : agents) {
            try {
                List<RawPositionReport> reports = agent.poll();
                // Counted per agent, not per cycle: each configured
                // FlightDataAgent's poll() is its own outbound call to its
                // own data source. Counted even when poll() itself skipped
                // the network call (e.g. OpenSkyAgent's own PollBackoff
                // cooling down) — from here there's no way to tell "no
                // data" apart from "didn't actually try", and erring
                // toward exhausting the budget a little early during a
                // run of failures is the safer side to be wrong on.
                pollWindowService.recordHotPollCall();
                if (!reports.isEmpty()) {
                    List<RawPositionReport> newAircraft = persistenceService.persist(agent.sourceName(), reports);
                    // Fired after persist()'s transaction has committed (we're back
                    // on the caller now), not from inside it — the enrichment lookup
                    // runs on a separate @Async thread, so kicking it off mid-transaction
                    // risks that thread querying for the aircraft row before this
                    // transaction has actually committed it.
                    newAircraft.forEach(r -> enrichmentService.enrichNewAircraft(r.icao24(), r.callsign()));
                }
            } catch (Exception e) {
                log.warn("Agent {} failed this cycle", agent.sourceName(), e);
            }
        }
    }

    // Deliberately not gated by pollWindowService — this runs always,
    // independent of whether anyone's actively watching the map, so the
    // database has recent global coverage even for aircraft nobody's
    // viewport has ever hot-polled. Each agent decides for itself whether
    // it supports this (FlightDataAgent.pollGlobal() defaults to empty).
    //
    // Deliberately does NOT trigger enrichment (unlike pollAll above) — one
    // sweep can surface several thousand aircraft nobody's looking at.
    // Eagerly enriching all of them overwhelms the 2-worker async queue and
    // the external APIs' rate limits, so in practice almost none of them
    // actually get enriched (confirmed live: 92% of all known aircraft
    // stuck permanently unenriched under this load). Aircraft the global
    // sweep finds get enriched lazily instead, on demand, the moment
    // someone actually asks for their dossier — see AircraftController.
    // initialDelay matches the interval, not 0: without it, @Scheduled's
    // own default "run once immediately" would fire a second sweep right
    // on top of seedOnStartup()'s — harmless (upserts are idempotent) but
    // a wasted API call/credit every single boot.
    @Scheduled(
            initialDelayString = "#{${flighttracker.agents.global-sweep-interval-seconds:360} * 1000}",
            fixedDelayString = "#{${flighttracker.agents.global-sweep-interval-seconds:360} * 1000}")
    public void pollGlobalSweep() {
        runGlobalSweep();
    }

    private void runGlobalSweep() {
        for (FlightDataAgent agent : agents) {
            try {
                List<RawPositionReport> reports = agent.pollGlobal();
                if (!reports.isEmpty()) {
                    // persistBatch, not persist: this list can be ~13k
                    // reports worldwide, where persist()'s one-row-at-a-time
                    // approach measured taking ~14 minutes in production —
                    // see PositionPersistenceService.persistBatch's javadoc.
                    persistenceService.persistBatch(agent.sourceName(), reports);
                }
            } catch (Exception e) {
                log.warn("Agent {} global sweep failed", agent.sourceName(), e);
            }
        }
    }
}
