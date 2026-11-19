package com.flighttracker.service.confirmation;

import com.flighttracker.model.Aircraft;
import com.flighttracker.repository.AircraftRepository;

import java.time.Duration;
import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.function.Predicate;

/**
 * The board entry for a candidate: by normalised callsign, else by
 * registration when both sides have one (the aircraft table's, from adsbdb).
 * Several entries with the same callsign (a flight that runs twice a day)
 * resolve to the one whose landing is nearest the expected touchdown.
 */
final class BoardEntryMatcher {

    private final AircraftRepository aircraftRepository;

    BoardEntryMatcher(AircraftRepository aircraftRepository) {
        this.aircraftRepository = aircraftRepository;
    }

    BoardEntry match(BoardResult board, ArrivalCandidate c) {
        String callsign = BoardEntry.normalizeCallsign(c.aircraft().callsign());
        BoardEntry best = callsign.isEmpty() ? null
                : nearest(board, e -> callsign.equals(BoardEntry.normalizeCallsign(e.callsign())), c);
        if (best != null) return best;
        if (board.entries().stream().allMatch(e -> registrationOf(e).isEmpty())) return null;
        String registration = BoardEntry.normalizeRegistration(
                aircraftRepository.findById(c.aircraft().icao24()).map(Aircraft::registration).orElse(null));
        if (registration.isEmpty()) return null;
        return nearest(board, e -> registration.equals(registrationOf(e)), c);
    }

    private static String registrationOf(BoardEntry e) {
        return BoardEntry.normalizeRegistration(e.registration());
    }

    private static BoardEntry nearest(BoardResult board, Predicate<BoardEntry> filter, ArrivalCandidate c) {
        List<BoardEntry> entries = board.entries().stream().filter(filter).toList();
        return entries.stream().min(Comparator.comparingLong((BoardEntry e) -> offsetMillis(e, c.expectedAt())))
                .orElse(null);
    }

    private static long offsetMillis(BoardEntry e, Instant expectedAt) {
        Instant landed = e.info() == null ? null : e.info().landedAt();
        return landed == null ? Long.MAX_VALUE : Math.abs(Duration.between(landed, expectedAt).toMillis());
    }
}
