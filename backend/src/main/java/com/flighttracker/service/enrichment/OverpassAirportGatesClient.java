package com.flighttracker.service.enrichment;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Real airport infrastructure (terminal/apron/hangar buildings, individual
 * gate positions) from OpenStreetMap via the public Overpass API — no
 * bundled dataset has this (Natural Earth and OurAirports, already used
 * for country/city/runway data, stop at runway centerlines; see
 * worldMapData.ts's header). Proxied server-side because
 * overpass-api.de's responses carry no Access-Control-Allow-Origin
 * header — confirmed by hand, not documented anywhere — so a direct
 * browser fetch is blocked by CORS regardless of how the request itself
 * is built.
 *
 * Cached in memory per airport code, unbounded, no expiry: real airport
 * infrastructure changes on a timescale of years, not something worth a
 * TTL or persistence layer for. Bounded in practice by how many distinct
 * airports anyone viewing the map actually zooms in on.
 */
@Component
public class OverpassAirportGatesClient {

    private static final Logger log = LoggerFactory.getLogger(OverpassAirportGatesClient.class);

    // Half-width of the query bbox around an airport's reference point, in
    // degrees — roughly 2.2km at mid-latitudes (longitude compresses
    // poleward, but airports aren't built near the poles). Comfortably
    // covers a typical single/dual-runway airport's whole terminal+apron
    // complex; a handful of the largest hub airports in the world (DXB,
    // ORD, DFW) extend a bit past this — acceptable for a first pass
    // rather than a per-airport-sized query, which would need real airport
    // boundary data this whole feature exists because we don't have.
    private static final double BBOX_HALF_DEGREES = 0.02;

    private final RestClient client;
    private final Map<String, List<AirportGateFeature>> cache = new ConcurrentHashMap<>();

    public OverpassAirportGatesClient() {
        SimpleClientHttpRequestFactory requestFactory = new SimpleClientHttpRequestFactory();
        requestFactory.setConnectTimeout(5_000);
        // Overpass queries against a real airport's full infrastructure can
        // legitimately take several seconds on the shared public instance —
        // longer than this app's other external calls, which are all
        // small, indexed, single-record lookups by comparison.
        requestFactory.setReadTimeout(20_000);
        this.client = RestClient.builder()
                .baseUrl("https://overpass-api.de/api")
                .requestFactory(requestFactory)
                .build();
    }

    /**
     * Best-effort: any failure (timeout, malformed response, Overpass's
     * own rate-limiting) degrades to an empty list rather than
     * propagating — this is basemap decoration, not core flight data, and
     * VectorBasemap already falls back to the runway-only view when
     * nothing's returned.
     */
    public List<AirportGateFeature> fetchGates(String airportCode, double lat, double lon) {
        List<AirportGateFeature> cached = cache.get(airportCode);
        if (cached != null) return cached;

        String bbox = String.format(Locale.ROOT, "%f,%f,%f,%f",
                lat - BBOX_HALF_DEGREES, lon - BBOX_HALF_DEGREES,
                lat + BBOX_HALF_DEGREES, lon + BBOX_HALF_DEGREES);
        String query = """
                [out:json][timeout:15];
                (
                  way["aeroway"="apron"](%s);
                  way["aeroway"="terminal"](%s);
                  way["building"="terminal"](%s);
                  way["aeroway"="hangar"](%s);
                  node["aeroway"="gate"](%s);
                );
                out geom;
                """.formatted(bbox, bbox, bbox, bbox, bbox);

        try {
            OverpassResponse body = client.post()
                    .uri("/interpreter")
                    .contentType(MediaType.APPLICATION_FORM_URLENCODED)
                    .body("data=" + query)
                    .retrieve()
                    .body(OverpassResponse.class);

            List<AirportGateFeature> features = toFeatures(body);
            cache.put(airportCode, features);
            return features;
        } catch (Exception e) {
            log.debug("Overpass gate fetch failed for {}: {}", airportCode, e.toString());
            // Not cached on failure — a transient Overpass hiccup shouldn't
            // permanently blank an airport for the rest of the process's
            // lifetime the way a real "no data here" result should.
            return List.of();
        }
    }

    private static List<AirportGateFeature> toFeatures(OverpassResponse body) {
        if (body == null || body.elements() == null) return List.of();
        List<AirportGateFeature> features = new ArrayList<>();
        for (OverpassElement el : body.elements()) {
            String kind = classify(el.tags());
            if (kind == null) continue;
            if ("node".equals(el.type())) {
                if (el.lat() == null || el.lon() == null) continue;
                features.add(new AirportGateFeature(kind, List.of(new double[]{el.lon(), el.lat()})));
            } else if (el.geometry() != null && !el.geometry().isEmpty()) {
                List<double[]> ring = new ArrayList<>();
                for (OverpassLatLon p : el.geometry()) {
                    if (p == null) continue; // Overpass emits a null entry for a way whose geometry it couldn't fully resolve
                    ring.add(new double[]{p.lon(), p.lat()});
                }
                if (ring.size() >= 2) features.add(new AirportGateFeature(kind, ring));
            }
        }
        return features;
    }

    private static String classify(Map<String, String> tags) {
        if (tags == null) return null;
        if ("gate".equals(tags.get("aeroway"))) return "gate";
        if ("apron".equals(tags.get("aeroway"))) return "apron";
        if ("terminal".equals(tags.get("aeroway")) || "terminal".equals(tags.get("building"))) return "terminal";
        if ("hangar".equals(tags.get("aeroway"))) return "hangar";
        return null;
    }

    public record AirportGateFeature(String kind, List<double[]> ring) {
    }

    // Field names match Overpass's own JSON keys (out geom output).
    private record OverpassResponse(List<OverpassElement> elements) {
    }

    private record OverpassElement(String type, Double lat, Double lon, List<OverpassLatLon> geometry,
                                    Map<String, String> tags) {
    }

    private record OverpassLatLon(Double lat, Double lon) {
    }
}
