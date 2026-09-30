package com.flighttracker.service.live;

import com.flighttracker.model.FlightPosition;

import java.util.List;

/**
 * Published by PositionPersistenceService.persist() (the hot-poll write
 * path) once its transaction has actually committed the given reports to
 * flight_position — replaces the old cross-container Postgres LISTEN/NOTIFY
 * bridge (PositionNotificationListener) now that everything runs in one
 * process. LiveFeedBroadcaster consumes this to fan positions out over the
 * WebSocket.
 *
 * Deliberately not published from persistBatch() (the global sweep's write
 * path) — same reasoning as the old NOTIFY-per-row skip that used to live
 * there: nobody's actively watching an aircraft the *global* sweep found,
 * by definition, so there's nothing worth pushing live for it. See
 * PositionPersistenceService.persistBatch's javadoc.
 */
public record PositionsPersistedEvent(List<FlightPosition> positions) {
}
