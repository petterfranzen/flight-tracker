package com.flighttracker.service.agent;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Polls OpenSky Network's free REST endpoint for state vectors in a bounding
 * box. Anonymous access is rate-limited (roughly one request per 10s) —
 * fine for a demo, register for a free account and add basic auth via
 * RestClient if you need tighter polling.
 * Docs: https://openskynetwork.github.io/opensky-api/rest.html
 */
@Component
public class OpenSkyAgent implements FlightDataAgent {

    private final RestClient client;
    private final String url;
    private final boolean enabled;

    public OpenSkyAgent(
            @Value("${flighttracker.agents.opensky.enabled:true}") boolean enabled,
            @Value("${flighttracker.agents.opensky.base-url}") String baseUrl,
            @Value("${flighttracker.agents.opensky.bbox.lat-min}") double latMin,
            @Value("${flighttracker.agents.opensky.bbox.lat-max}") double latMax,
            @Value("${flighttracker.agents.opensky.bbox.lon-min}") double lonMin,
            @Value("${flighttracker.agents.opensky.bbox.lon-max}") double lonMax) {
        this.enabled = enabled;
        this.client = RestClient.create();
        this.url = baseUrl + "/states/all?lamin=" + latMin + "&lamax=" + latMax
                + "&lomin=" + lonMin + "&lomax=" + lonMax;
    }

    @Override
    public String sourceName() {
        return "opensky";
    }

    @Override
    @SuppressWarnings("unchecked")
    public List<RawPositionReport> poll() {
        if (!enabled) return List.of();
        try {
            Map<String, Object> body = client.get().uri(url).retrieve().body(Map.class);
            if (body == null || body.get("states") == null) return List.of();

            List<List<Object>> states = (List<List<Object>>) body.get("states");
            List<RawPositionReport> out = new ArrayList<>();
            for (List<Object> s : states) {
                // OpenSky state vector array layout — index 5/6 = lon/lat.
                Double lon = asDouble(s.get(5));
                Double lat = asDouble(s.get(6));
                if (lon == null || lat == null) continue; // no fix yet, skip

                out.add(new RawPositionReport(
                        ((String) s.get(0)).trim(),                 // icao24
                        s.get(1) == null ? null : ((String) s.get(1)).trim(), // callsign
                        Instant.ofEpochSecond(((Number) s.get(4)).longValue()),
                        lat, lon,
                        asDouble(s.get(7)),   // baro altitude, m
                        asDouble(s.get(9)),   // velocity, m/s
                        asDouble(s.get(10)),  // true track, deg
                        asDouble(s.get(11)),  // vertical rate, m/s
                        Boolean.TRUE.equals(s.get(8)) // on_ground
                ));
            }
            return out;
        } catch (Exception e) {
            // A flaky poll should never take the orchestrator down.
            return List.of();
        }
    }

    private static Double asDouble(Object o) {
        return o instanceof Number n ? n.doubleValue() : null;
    }
}
