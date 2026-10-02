package com.flighttracker.dto;

import java.util.List;

/**
 * The zoomed-out map in one response: the most active aircraft in view,
 * drawn individually, plus cluster bubbles for the rest of the active
 * traffic. The two never overlap — an aircraft in {@code planes} is not
 * counted in {@code clusters} — so planes + cluster counts is the active
 * traffic in the viewport. See LiveStateStore.overview.
 */
public record LiveOverview(List<LiveMarker> planes, List<ClusterPoint> clusters) {
}
