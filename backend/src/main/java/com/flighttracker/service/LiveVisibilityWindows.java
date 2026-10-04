package com.flighttracker.service;

import java.time.Duration;

/**
 * Shared cutoffs for "what counts as live right now" — used by
 * FlightController's /live and /search queries, AircraftController's
 * dossier (to stop the flight-time counter at the same presumed-landed
 * moment), and EstimatorAgent's own background refresh (which needs the
 * exact same live set FlightController would otherwise query, so its
 * estimates line up with what a request will actually see). Pulled out to
 * one place once a third consumer needed them — three independent copies
 * of the same tuning values was one refactor past worth it.
 */
public final class LiveVisibilityWindows {

    // Outer bound for an airborne aircraft that has gone silent (feed gap or
    // truly lost) — past this it is presumed to be on the ground somewhere
    // and is dropped from the live set. 12 hours, measured on the live
    // data: about 59,000 aircraft carried the "airborne" flag, of which only
    // 13% had reported in the previous 30 minutes and 55% had been silent
    // for over 12 hours. No flight stays in the air that long (the longest
    // scheduled legs are about 18 hours, and a coverage gap covers only the
    // ocean in the middle of one), so those are planes that landed and
    // switched their transponder off; their last report still says
    // "airborne, descending". Keeping them for 48 hours put ~70,000 aircraft
    // on the map, most of them parked ghosts, and made every request scan
    // them. Aircraft that land are not lost: LANDED_VISIBILITY covers the
    // ones that report from the ground, and any aircraft is back as soon as
    // it reports again.
    public static final Duration STALE_AIRBORNE_BOUND = Duration.ofHours(12);

    // How long a landed aircraft stays visible after touching down: a plane
    // parked at the gate is the case worth showing for a while, but a day
    // (not two) is plenty — one that has been on the ground for 24 hours
    // reappears the moment it reports again.
    public static final Duration LANDED_VISIBILITY = Duration.ofHours(24);

    // The longest of the two windows above: an aircraft silent for longer
    // than this can never be live again without a new report, so it is safe
    // to forget (LiveStateStore.evictSilentBefore) and is not worth loading
    // back from the database after a restart.
    public static final Duration LONGEST_VISIBILITY =
            STALE_AIRBORNE_BOUND.compareTo(LANDED_VISIBILITY) >= 0 ? STALE_AIRBORNE_BOUND : LANDED_VISIBILITY;

    // An airborne aircraft that's gone silent this long *and* was
    // descending on its last report is presumed to have landed (and
    // dropped off ADS-B coverage on the ground) rather than still being
    // airborne somewhere. Used only for display framing — AircraftController
    // freezes the flight-time counter and switches its status text to
    // "likely landed" once this fires — not to prune the aircraft from the
    // live view; it keeps showing (dead-reckoned to its destination, then
    // parked there) until STALE_AIRBORNE_BOUND runs out.
    public static final Duration PRESUMED_LANDED_SILENCE = Duration.ofMinutes(30);

    // "Active traffic": in the air and reported within this long. What the
    // zoomed-out cluster bubbles count, so a cluster means flights in
    // progress rather than every aircraft the map still remembers (a plane
    // parked at a gate stays visible for LANDED_VISIBILITY, which would
    // otherwise make an airport look like a busy sky). Everything else is
    // still returned by /live and drawn individually once zoomed in. Equal to
    // the frontend's DIM_AFTER_MS (map/staleness.ts), so the aircraft drawn
    // dimmed up close are exactly the ones left out of the bubbles.
    public static final Duration ACTIVE_TRAFFIC_WINDOW = Duration.ofHours(2);

    private LiveVisibilityWindows() {
    }
}
