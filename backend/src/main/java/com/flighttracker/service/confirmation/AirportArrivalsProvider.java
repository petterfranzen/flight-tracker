package com.flighttracker.service.confirmation;

import java.time.LocalDate;

/**
 * The second provider shape: a source that serves a whole arrivals board per
 * airport and date (Swedavia FlightInfo is one), where
 * {@link ArrivalConfirmationProvider} is asked about one flight at a time.
 * One {@link #fetchArrivals} call answers every candidate at that airport, so
 * the gateway caches boards (not flights) and the service matches aircraft
 * against the cached board without a call.
 *
 * <p>The rules of {@link ArrivalConfirmationProvider} apply unchanged: a
 * {@code @Component}, a short stable {@link #id()}, its own
 * {@code flighttracker.confirmation.<id>.enabled} flag, the API key from an
 * environment variable, {@link #covers} as a cheap local check, and
 * {@link #fetchArrivals} is synchronous on the shared scheduler thread, so it
 * sets HTTP timeouts, does no caching, pacing or backoff of its own, and
 * should not throw.
 *
 * <p>A provider may keep incremental state of its own (a continuation token
 * that returns only what changed since the last call, say) as long as what it
 * returns is the complete board for that airport and date: the framework sees
 * boards only, and it replaces the cached one wholesale.
 */
public interface AirportArrivalsProvider {

    /** Short stable identifier, lower case, for example {@code swedavia}. It becomes the status {@code source}. */
    String id();

    /** False while the provider's own enabled flag is off; a disabled provider is never asked. */
    default boolean enabled() {
        return true;
    }

    /** True when this provider serves an arrivals board for the airport (ICAO code, may be null if unknown). */
    boolean covers(String arrivalAirportIcao);

    /**
     * The arrivals board of one airport for one UTC date. Called by the
     * gateway, which has already checked the cache, the pacing, the budgets
     * and the backoff. Set {@link BoardResult#costUnits()} to what the call
     * cost upstream when it is not 1 (several pages, a pricier endpoint).
     */
    BoardResult fetchArrivals(String arrivalAirportIcao, LocalDate dateUtc);
}
