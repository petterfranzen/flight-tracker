package com.flighttracker.service.confirmation;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** A board provider with boards set by the test; records every fetch as "airport@date". */
final class FakeArrivalBoards implements AirportArrivalsProvider {
    final String id;
    final List<String> fetches = new ArrayList<>();
    boolean enabled = true;
    List<String> airports = null; // null = covers everything
    final Map<String, List<BoardEntry>> boards = new LinkedHashMap<>(); // by airport
    BoardResult override;

    FakeArrivalBoards(String id) {
        this.id = id;
    }

    @Override public String id() { return id; }
    @Override public boolean enabled() { return enabled; }
    @Override public boolean covers(String airport) { return airports == null || (airport != null && airports.contains(airport)); }
    @Override public BoardResult fetchArrivals(String airport, LocalDate dateUtc) {
        fetches.add(airport + "@" + dateUtc);
        return override != null ? override : BoardResult.found(boards.getOrDefault(airport, List.of()));
    }
}
