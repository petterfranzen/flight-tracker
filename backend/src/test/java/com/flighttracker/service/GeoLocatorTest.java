package com.flighttracker.service;

import com.flighttracker.dto.GeoPoint;
import org.junit.jupiter.api.Test;

import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;

class GeoLocatorTest {

    private static Optional<GeoPoint> from(Map<String, String> headers) {
        return GeoLocator.fromHeaders(headers::get);
    }

    @Test
    void coordinatesFromCloudflareAreUsedAndRoundedToATenthOfADegree() {
        GeoPoint p = from(Map.of("CF-IPLatitude", "53.4808", "CF-IPLongitude", "-2.2426", "CF-IPCountry", "GB")).orElseThrow();
        assertThat(p.lat()).isEqualTo(53.5);
        assertThat(p.lon()).isEqualTo(-2.2);
        assertThat(p.precision()).isEqualTo("city");
    }

    @Test
    void withoutCoordinatesTheCountryCapitalStandsIn() {
        GeoPoint p = from(Map.of("CF-IPCountry", "gb")).orElseThrow();
        assertThat(p.precision()).isEqualTo("country");
        assertThat(p.lat()).isEqualTo(51.5);
        assertThat(p.lon()).isEqualTo(-0.1);
    }

    @Test
    void malformedOrOutOfRangeCoordinatesFallBackToTheCountry() {
        assertThat(from(Map.of("CF-IPLatitude", "abc", "CF-IPLongitude", "1", "CF-IPCountry", "SE")).orElseThrow().precision()).isEqualTo("country");
        assertThat(from(Map.of("CF-IPLatitude", "95", "CF-IPLongitude", "10", "CF-IPCountry", "SE")).orElseThrow().precision()).isEqualTo("country");
        assertThat(from(Map.of("CF-IPLatitude", "NaN", "CF-IPLongitude", "10", "CF-IPCountry", "SE")).orElseThrow().precision()).isEqualTo("country");
        assertThat(from(Map.of("CF-IPLatitude", "59.3"))).isEmpty(); // longitude missing, no country
    }

    @Test
    void nothingUsableGivesEmpty() {
        assertThat(from(Map.of())).isEmpty();
        assertThat(from(Map.of("CF-IPCountry", "XX"))).isEmpty(); // unknown / Cloudflare's "no data" codes
        assertThat(from(Map.of("CF-IPCountry", "T1"))).isEmpty(); // Tor
    }
}
