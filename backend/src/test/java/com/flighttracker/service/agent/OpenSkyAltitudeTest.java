package com.flighttracker.service.agent;

import org.junit.jupiter.api.Test;

import java.util.Arrays;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/** Which of OpenSky's two altitudes a report carries (OpenSkyAgent.altitudeM). */
class OpenSkyAltitudeTest {

    /** An OpenSky state vector with the given barometric (index 7) and geometric (index 13) altitude. */
    private static List<Object> state(Double baro, Double geo) {
        Object[] s = new Object[17];
        s[0] = "4aab14";
        s[7] = baro;
        s[13] = geo;
        return Arrays.asList(s);
    }

    @Test
    void prefersGeometricAltitude() {
        // SEKHU read -46 m barometric on a high-pressure day.
        assertThat(OpenSkyAgent.altitudeM(state(-46.0, 38.1))).isEqualTo(38.1);
    }

    @Test
    void fallsBackToBarometricWithoutGeometric() {
        assertThat(OpenSkyAgent.altitudeM(state(1200.0, null))).isEqualTo(1200.0);
        assertThat(OpenSkyAgent.altitudeM(Arrays.asList(new Object[]{"4aab14", null, null, null, null, null, null, 900.0}))).isEqualTo(900.0);
    }

    @Test
    void neitherIsNull() {
        assertThat(OpenSkyAgent.altitudeM(state(null, null))).isNull();
    }
}
