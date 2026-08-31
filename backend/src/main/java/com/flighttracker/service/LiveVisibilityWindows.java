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
    // than keep it on the map indefinitely. Aircraft don't vanish — they
    // land, sit at a gate, and eventually depart again under the same or a
    // new callsign — so this is deliberately generous rather than tuned to
    // "how long can an ADS-B gap plausibly last": 48 hours comfortably
    // covers a plane sitting on the ground long after its last airborne
    // report, not just a coverage gap mid-flight.
    public static final Duration STALE_AIRBORNE_BOUND = Duration.ofHours(48);

    // How long a landed aircraft stays visible after touching down. Matched
    // to STALE_AIRBORNE_BOUND for the same reason — a plane parked at the
    // gate is exactly the case we want to keep showing, not prune quickly.
    public static final Duration LANDED_VISIBILITY = Duration.ofHours(48);

    // An airborne aircraft that's gone silent this long *and* was
    // descending on its last report is presumed to have landed (and
    // dropped off ADS-B coverage on the ground) rather than still being
    // airborne somewhere. Used only for display framing — AircraftController
    // freezes the flight-time counter and switches its status text to
    // "likely landed" once this fires — not to prune the aircraft from the
    // live view; it keeps showing (dead-reckoned to its destination, then
    // parked there) for the same STALE_AIRBORNE_BOUND/LANDED_VISIBILITY
    // window as everything else.
    public static final Duration PRESUMED_LANDED_SILENCE = Duration.ofMinutes(30);

    private LiveVisibilityWindows() {
    }
}
