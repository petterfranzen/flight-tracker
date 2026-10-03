package com.flighttracker.dto;

/**
 * A visitor's approximate location, for choosing where the map opens.
 * Coarse on purpose (rounded to 0.1 degree, about 11 km) and never stored.
 *
 * @param precision "city" when Cloudflare supplied coordinates, "country" when
 *                  only the country code was available and the country's
 *                  capital stands in.
 */
public record GeoPoint(double lat, double lon, String precision) {
}
