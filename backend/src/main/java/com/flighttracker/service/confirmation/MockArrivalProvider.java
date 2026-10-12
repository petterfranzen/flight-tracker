package com.flighttracker.service.confirmation;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Locale;

/**
 * A stand-in provider for development and for showing the whole journey in
 * the UI ("Coverage lost", "Landed 92% (inferred)", "At gate B14 (confirmed)")
 * without a real feed. Off by default; turn it on with
 * {@code FLIGHTTRACKER_CONFIRMATION_MOCK_ENABLED=true}. It covers every
 * airport, makes no external calls and is deterministic from the query:
 * <ul>
 *   <li>actualOn is the expected arrival time;</li>
 *   <li>actualIn is actualOn + 8 min, reported once the clock has passed it;</li>
 *   <li>the gate and terminal come from a hash of the callsign;</li>
 *   <li>a fixed fraction of callsigns (also from the hash) is NOT_FOUND, so the
 *       unconfirmed path shows up too.</li>
 * </ul>
 */
@Component
public class MockArrivalProvider implements ArrivalConfirmationProvider {

    static final String ID = "mock";
    static final Duration TAXI_IN = Duration.ofMinutes(8);

    private final Clock clock;
    private final boolean enabled;
    private final double notFoundFraction;

    public MockArrivalProvider(Clock clock,
                               @Value("${flighttracker.confirmation.mock.enabled:false}") boolean enabled,
                               @Value("${flighttracker.confirmation.mock.not-found-fraction:0.2}") double notFoundFraction) {
        this.clock = clock;
        this.enabled = enabled;
        this.notFoundFraction = notFoundFraction;
    }

    @Override
    public String id() {
        return ID;
    }

    @Override
    public boolean enabled() {
        return enabled;
    }

    @Override
    public boolean covers(String arrivalAirportIcao) {
        return true;
    }

    @Override
    public LookupResult lookup(ArrivalQuery query) {
        if (query.callsign() == null || query.expectedArrivalAt() == null) return LookupResult.notFound();
        int x = query.callsign().trim().toUpperCase(Locale.ROOT).hashCode() * 0x9E3779B1;
        int h = (x ^ (x >>> 15)) & 0x7fffffff;
        if (h % 100 < notFoundFraction * 100) return LookupResult.notFound();

        Instant on = query.expectedArrivalAt();
        Instant in = on.plus(TAXI_IN);
        boolean atGate = !clock.instant().isBefore(in);
        String gate = "" + (char) ('A' + (h / 100) % 5) + (1 + (h / 500) % 40);
        String terminal = String.valueOf(1 + (h / 7) % 5);
        return LookupResult.found(new ArrivalInfo(null, null, on, atGate ? in : null, gate, terminal,
                query.arrivalAirportIcao()));
    }
}
