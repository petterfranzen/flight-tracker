package com.flighttracker.service;

import java.time.Duration;

/**
 * Shared cutoffs for "what counts as live right now" — used by
 * FlightController's /live and /search queries, AircraftController's
 * dossier (to stop the flight-time counter at the same presumed-landed
 * moment), and EstimatedPositionCache's own background refresh (which
 * needs the exact same live set FlightController would otherwise query,
 * so its cache lines up with what a request will actually see). Pulled
 * out to one place once a third consumer needed them — three independent
 * copies of the same tuning values was one refactor past worth it.
 */
public final class LiveVisibilityWindows {

    // Outer bound for an airborne aircraft that's gone silent (feed gap or
    // truly lost) — past this, presume it's no longer worth showing rather
    // than keep it on the map indefinitely. Not user-specified; a few hours
    // comfortably covers real ADS-B gaps without letting a dead icao24
    // linger forever.
    public static final Duration STALE_AIRBORNE_BOUND = Duration.ofHours(4);

    // How long a landed aircraft stays visible after touching down.
    public static final Duration LANDED_VISIBILITY = Duration.ofMinutes(20);

    // An airborne aircraft that's gone silent this long *and* was
    // descending on its last report is presumed to have landed (and
    // dropped off ADS-B coverage on the ground) rather than still being
    // airborne somewhere — pruned from the live view well before
    // STALE_AIRBORNE_BOUND would otherwise drop it.
    public static final Duration PRESUMED_LANDED_SILENCE = Duration.ofMinutes(30);

    // A last-report vertical rate below this reads as genuinely descending
    // rather than jitter around level flight (same noise-tolerance idea as
    // FlightPhaseClassifier.LEVEL_TREND_THRESHOLD_M, just applied to a
    // single instantaneous reading instead of an altitude trend).
    public static final double DESCENDING_VERTICAL_RATE_MS = -1.0;

    private LiveVisibilityWindows() {
    }
}
