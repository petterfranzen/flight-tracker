package com.flighttracker.service.coverage;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class RunwayIndexTest {

    private static Runway rw(String icao, String ident, double lat, double lon) {
        return new Runway(icao, ident, lat, lon, 90.0, 10.0, 3000.0);
    }

    private static RunwayIndex indexOf(Runway... runways) {
        RunwayIndex index = new RunwayIndex();
        index.replace(List.of(runways));
        return index;
    }

    @Test
    void near_filtersByRadiusAndSortsByDistance() {
        // 0.01 deg of latitude is about 1.11 km
        Runway close = rw("AAAA", "09", 60.01, 10.0);
        Runway mid = rw("BBBB", "09", 60.03, 10.0);
        Runway far = rw("CCCC", "09", 60.10, 10.0);
        RunwayIndex index = indexOf(far, mid, close);

        assertThat(index.near(60.0, 10.0, 5_000)).containsExactly(close, mid);
        assertThat(index.near(60.0, 10.0, 1_000)).isEmpty();
        assertThat(index.near(60.0, 10.0, 20_000)).containsExactly(close, mid, far);
    }

    @Test
    void near_findsRunwaysAcrossACellBoundary() {
        // The 59.5 latitude and 18.0 longitude lines are cell edges (0.5 deg grid).
        Runway south = rw("AAAA", "01", 59.4999, 17.9999);
        Runway north = rw("BBBB", "01", 59.5001, 18.0001);
        RunwayIndex index = indexOf(south, north);

        assertThat(index.near(59.5, 18.0, 100)).containsExactlyInAnyOrder(south, north);
        assertThat(index.near(59.5003, 18.0003, 40)).containsExactly(north);
    }

    @Test
    void near_wrapsAcrossTheAntimeridian() {
        Runway east = rw("AAAA", "09", 10.0, 179.9990);
        Runway west = rw("BBBB", "09", 10.0, -179.9990);
        RunwayIndex index = indexOf(east, west);

        // 0.001 deg of longitude at the equator is about 110 m
        assertThat(index.near(10.0, 179.9995, 500)).containsExactly(east, west);
        assertThat(index.near(10.0, -179.9995, 500)).containsExactly(west, east);
    }

    @Test
    void near_widensLongitudeSearchAtHighLatitude() {
        // At 70N a degree of longitude is only ~38 km, so 0.2 deg is ~7.6 km
        Runway r = rw("AAAA", "09", 70.0, 25.20);
        RunwayIndex index = indexOf(r);

        assertThat(index.near(70.0, 25.0, 10_000)).containsExactly(r);
        assertThat(index.near(70.0, 25.0, 5_000)).isEmpty();
    }

    @Test
    void near_toleratesPolesAndHugeRadii() {
        Runway r = rw("AAAA", "09", 89.99, 10.0);
        RunwayIndex index = indexOf(r);

        assertThat(index.near(89.995, -170.0, 5_000)).containsExactly(r);
        assertThat(index.near(0.0, 0.0, 30_000_000)).containsExactly(r);
    }

    @Test
    void near_onEmptyIndexIsEmpty() {
        assertThat(new RunwayIndex().near(0, 0, 100_000)).isEmpty();
    }

    @Test
    void atAirport_returnsThatAirportsRunways() {
        Runway a1 = rw("ESSA", "01L", 59.637, 17.913);
        Runway a2 = rw("ESSA", "19R", 59.666, 17.923);
        Runway b = rw("ESGG", "03", 57.66, 12.27);
        RunwayIndex index = indexOf(a1, a2, b);

        assertThat(index.atAirport("ESSA")).containsExactlyInAnyOrder(a1, a2);
        assertThat(index.atAirport("ESGG")).containsExactly(b);
        assertThat(index.atAirport("XXXX")).isEmpty();
        assertThat(index.size()).isEqualTo(3);
    }

    @Test
    void replace_swapsTheWholeSnapshot() {
        Runway old = rw("AAAA", "09", 10.0, 10.0);
        Runway fresh = rw("BBBB", "09", 20.0, 20.0);
        RunwayIndex index = indexOf(old);

        index.replace(List.of(fresh));

        assertThat(index.near(10.0, 10.0, 1_000)).isEmpty();
        assertThat(index.atAirport("AAAA")).isEmpty();
        assertThat(index.near(20.0, 20.0, 1_000)).containsExactly(fresh);
    }
}
