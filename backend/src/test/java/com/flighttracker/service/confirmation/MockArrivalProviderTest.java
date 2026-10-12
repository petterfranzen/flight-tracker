package com.flighttracker.service.confirmation;

import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;

class MockArrivalProviderTest {

    private static final Instant ON = Instant.parse("2026-10-12T11:00:00Z");

    private final TestClock clock = new TestClock();

    private MockArrivalProvider provider(boolean enabled, double notFoundFraction) {
        clock.set(ON);
        return new MockArrivalProvider(clock, enabled, notFoundFraction);
    }

    private static ArrivalQuery query(String callsign) {
        return new ArrivalQuery("abc123", callsign, "ESSA", ON);
    }

    @Test
    void isDisabledUntilSwitchedOn_andCoversEveryAirport() {
        assertThat(provider(false, 0).enabled()).isFalse();
        assertThat(provider(true, 0).enabled()).isTrue();
        assertThat(provider(true, 0).covers("ESSA")).isTrue();
        assertThat(provider(true, 0).covers("KJFK")).isTrue();
        assertThat(provider(true, 0).id()).isEqualTo("mock");
    }

    @Test
    void reportsActualOnAsTheExpectedArrival_andNoGateInYet() {
        LookupResult r = provider(true, 0).lookup(query("SAS123"));

        assertThat(r.status()).isEqualTo(LookupResult.Status.FOUND);
        assertThat(r.info().actualOn()).isEqualTo(ON);
        assertThat(r.info().actualIn()).isNull();
        assertThat(r.info().arrivalAirportIcao()).isEqualTo("ESSA");
        assertThat(r.info().gate()).matches("[A-E]\\d{1,2}");
        assertThat(r.info().terminal()).matches("[1-5]");
    }

    @Test
    void reportsGateInEightMinutesAfterLanding_onceTheClockHasPassedIt() {
        MockArrivalProvider p = provider(true, 0);

        clock.set(ON.plus(Duration.ofMinutes(8)).minusSeconds(1));
        assertThat(p.lookup(query("SAS123")).info().actualIn()).isNull();

        clock.set(ON.plus(Duration.ofMinutes(8)));
        assertThat(p.lookup(query("SAS123")).info().actualIn()).isEqualTo(ON.plus(Duration.ofMinutes(8)));
    }

    @Test
    void isDeterministic_andTheGateDependsOnTheCallsign() {
        MockArrivalProvider p = provider(true, 0);

        assertThat(p.lookup(query("SAS123"))).isEqualTo(p.lookup(query("SAS123")));
        assertThat(p.lookup(query("sas123 "))).isEqualTo(p.lookup(query("SAS123")));
        long distinctGates = java.util.stream.IntStream.range(100, 160)
                .mapToObj(i -> p.lookup(query("SAS" + i)).info().gate()).distinct().count();
        assertThat(distinctGates).isGreaterThan(10);
    }

    @Test
    void aFractionOfCallsignsIsNotFound_andNoneWhenZero() {
        MockArrivalProvider some = provider(true, 0.3);
        MockArrivalProvider none = provider(true, 0);
        int notFound = 0;
        for (int i = 0; i < 500; i++) {
            if (some.lookup(query("CS" + i)).status() == LookupResult.Status.NOT_FOUND) notFound++;
            assertThat(none.lookup(query("CS" + i)).status()).isEqualTo(LookupResult.Status.FOUND);
        }
        assertThat(notFound).isBetween(100, 200);
        assertThat(some.lookup(query("CS7"))).isEqualTo(some.lookup(query("CS7")));
    }

    @Test
    void withoutACallsignOrArrivalTime_isNotFound() {
        MockArrivalProvider p = provider(true, 0);

        assertThat(p.lookup(new ArrivalQuery("abc123", null, "ESSA", ON)).status()).isEqualTo(LookupResult.Status.NOT_FOUND);
        assertThat(p.lookup(new ArrivalQuery("abc123", "SAS123", "ESSA", null)).status()).isEqualTo(LookupResult.Status.NOT_FOUND);
    }
}
