package com.flighttracker.service;

import com.flighttracker.dto.GeoPoint;

import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.function.Function;

/**
 * Where a request roughly comes from, read from Cloudflare's visitor-location
 * headers (the site is only reachable through the Cloudflare Tunnel, which is
 * also why ClientIpResolver trusts CF-Connecting-IP).
 *
 * <ul>
 *   <li>CF-IPLatitude / CF-IPLongitude: present when the zone has the "Add
 *       visitor location headers" managed transform on. City-level.</li>
 *   <li>CF-IPCountry: always present. Used as a fallback, mapped to the
 *       country's capital, so the feature works before that transform is on.</li>
 * </ul>
 *
 * Pure (takes a header lookup), nothing stored or logged. Coordinates are
 * rounded to 0.1 degree. Absent, malformed or out-of-range values give empty,
 * and the caller keeps its default view.
 */
public final class GeoLocator {

    private GeoLocator() {
    }

    // Capitals, as (lat, lon). Not exhaustive: an unlisted country gives empty.
    private static final Map<String, double[]> COUNTRY_CAPITALS = Map.ofEntries(
            Map.entry("GB", new double[]{51.51, -0.13}), Map.entry("IE", new double[]{53.35, -6.26}),
            Map.entry("FR", new double[]{48.86, 2.35}), Map.entry("DE", new double[]{52.52, 13.40}),
            Map.entry("ES", new double[]{40.42, -3.70}), Map.entry("PT", new double[]{38.72, -9.14}),
            Map.entry("IT", new double[]{41.90, 12.50}), Map.entry("NL", new double[]{52.37, 4.90}),
            Map.entry("BE", new double[]{50.85, 4.35}), Map.entry("LU", new double[]{49.61, 6.13}),
            Map.entry("CH", new double[]{46.95, 7.45}), Map.entry("AT", new double[]{48.21, 16.37}),
            Map.entry("DK", new double[]{55.68, 12.57}), Map.entry("SE", new double[]{59.33, 18.07}),
            Map.entry("NO", new double[]{59.91, 10.75}), Map.entry("FI", new double[]{60.17, 24.94}),
            Map.entry("IS", new double[]{64.15, -21.94}), Map.entry("PL", new double[]{52.23, 21.01}),
            Map.entry("CZ", new double[]{50.08, 14.44}), Map.entry("SK", new double[]{48.15, 17.11}),
            Map.entry("HU", new double[]{47.50, 19.04}), Map.entry("RO", new double[]{44.43, 26.10}),
            Map.entry("BG", new double[]{42.70, 23.32}), Map.entry("GR", new double[]{37.98, 23.73}),
            Map.entry("HR", new double[]{45.81, 15.98}), Map.entry("SI", new double[]{46.06, 14.51}),
            Map.entry("RS", new double[]{44.79, 20.45}), Map.entry("EE", new double[]{59.44, 24.75}),
            Map.entry("LV", new double[]{56.95, 24.11}), Map.entry("LT", new double[]{54.69, 25.28}),
            Map.entry("UA", new double[]{50.45, 30.52}), Map.entry("TR", new double[]{39.93, 32.86}),
            Map.entry("RU", new double[]{55.76, 37.62}), Map.entry("US", new double[]{38.90, -77.04}),
            Map.entry("CA", new double[]{45.42, -75.70}), Map.entry("MX", new double[]{19.43, -99.13}),
            Map.entry("BR", new double[]{-15.79, -47.88}), Map.entry("AR", new double[]{-34.60, -58.38}),
            Map.entry("CL", new double[]{-33.45, -70.67}), Map.entry("CO", new double[]{4.71, -74.07}),
            Map.entry("PE", new double[]{-12.05, -77.04}), Map.entry("AU", new double[]{-35.28, 149.13}),
            Map.entry("NZ", new double[]{-41.29, 174.78}), Map.entry("JP", new double[]{35.68, 139.69}),
            Map.entry("KR", new double[]{37.57, 126.98}), Map.entry("CN", new double[]{39.90, 116.41}),
            Map.entry("HK", new double[]{22.32, 114.17}), Map.entry("SG", new double[]{1.35, 103.82}),
            Map.entry("IN", new double[]{28.61, 77.21}), Map.entry("TH", new double[]{13.76, 100.50}),
            Map.entry("MY", new double[]{3.14, 101.69}), Map.entry("ID", new double[]{-6.21, 106.85}),
            Map.entry("PH", new double[]{14.60, 120.98}), Map.entry("VN", new double[]{21.03, 105.85}),
            Map.entry("AE", new double[]{24.45, 54.38}), Map.entry("SA", new double[]{24.71, 46.68}),
            Map.entry("QA", new double[]{25.29, 51.53}), Map.entry("IL", new double[]{31.77, 35.22}),
            Map.entry("EG", new double[]{30.04, 31.24}), Map.entry("ZA", new double[]{-25.75, 28.19}),
            Map.entry("KE", new double[]{-1.29, 36.82}), Map.entry("NG", new double[]{9.08, 7.40}),
            Map.entry("MA", new double[]{33.97, -6.85}));

    public static Optional<GeoPoint> fromHeaders(Function<String, String> header) {
        Double lat = number(header.apply("CF-IPLatitude"));
        Double lon = number(header.apply("CF-IPLongitude"));
        if (lat != null && lon != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
            return Optional.of(new GeoPoint(round(lat), round(lon), "city"));
        }
        String country = header.apply("CF-IPCountry");
        if (country == null) return Optional.empty();
        double[] capital = COUNTRY_CAPITALS.get(country.trim().toUpperCase(Locale.ROOT));
        return capital == null ? Optional.empty() : Optional.of(new GeoPoint(round(capital[0]), round(capital[1]), "country"));
    }

    private static Double number(String raw) {
        if (raw == null || raw.isBlank()) return null;
        try {
            double v = Double.parseDouble(raw.trim());
            return Double.isFinite(v) ? v : null;
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static double round(double v) {
        return Math.round(v * 10.0) / 10.0;
    }
}
