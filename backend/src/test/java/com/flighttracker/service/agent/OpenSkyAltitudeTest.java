package com.flighttracker.service.agent;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class OpenSkyAltitudeTest {

    /** An OpenSky state vector with only the altitude fields set: index 7 barometric, 13 geometric. */
    private static List<Object> state(Double baro, Double geo, int length) {
        List<Object> s = new ArrayList<>(Arrays.asList(new Object[length]));
        s.set(7, baro);
        if (length > 13) s.set(13, geo);
        return s;
    }

    @Test
    void prefersGeometricAltitude() {
        assertThat(OpenSkyAgent.altitude(state(-46.0, 38.1, 17))).isEqualTo(38.1);
    }

    @Test
    void fallsBackToBarometricWithoutAGeometricOne() {
        assertThat(OpenSkyAgent.altitude(state(1200.0, null, 17))).isEqualTo(1200.0);
        assertThat(OpenSkyAgent.altitude(state(1200.0, null, 12))).isEqualTo(1200.0);
    }
}
