package com.flighttracker.service.agent;

import java.util.List;

/**
 * One "agent" = one live-data source, polled independently and merged by
 * the orchestrator. Adding a new source (ADS-B Exchange, a scraped
 * per-airport feed, FlightAware, etc.) means adding one class that
 * implements this interface — that's deliberately the unit of work you'd
 * hand to a second coding agent (Codex/Gemini) to build in parallel while
 * Claude Code works on something else.
 */
public interface FlightDataAgent {

    /** Short, stable name written into flight_position.agent_source. */
    String sourceName();

    /** Fetch whatever the source currently reports for the currently-visible viewport. Never throws for a bad poll — return empty. */
    List<RawPositionReport> poll();

    /**
     * Fetch every aircraft the source reports worldwide, regardless of
     * visibility — for AgentOrchestrator's always-on global sweep (see
     * flighttracker.agents.global-sweep-interval-seconds). Optional: a
     * source with no practical way to query "everything" (e.g. one that's
     * inherently viewport/region-scoped) can just not override this.
     */
    default List<RawPositionReport> pollGlobal() {
        return List.of();
    }
}
