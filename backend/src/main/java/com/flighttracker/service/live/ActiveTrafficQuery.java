package com.flighttracker.service.live;

import com.flighttracker.dto.Bounds;

import java.time.Instant;

/**
 * Which aircraft the zoomed-out reads ({@link LiveStateStore#clustered},
 * {@link LiveStateStore#overview}, {@link LiveStateStore#discovered}) start
 * from: live under the two visibility cutoffs, in the air, reported at or
 * after {@code activeSince}, and inside {@code bounds}.
 */
public record ActiveTrafficQuery(Instant staleAirborneCutoff, Instant landedCutoff, Instant activeSince, Bounds bounds) {
}
