package com.flighttracker.service.confirmation;

/**
 * A source of actual arrival times and gates, such as an airport's flight
 * information API. {@link ArrivalConfirmationService} asks every enabled
 * provider whose {@link #covers} says yes about the aircraft that probably
 * landed, and turns a FOUND answer into LANDED_CONFIRMED or AT_GATE.
 *
 * <h2>Adding a real provider</h2>
 * Write one {@code @Component} that implements this interface; nothing is
 * wired by hand, the service collects every bean of this type.
 * <ul>
 *   <li>Give it a short, stable {@link #id()} (it becomes the status
 *       {@code source}, so it is shown as "Landed (confirmed · id)").</li>
 *   <li>Gate it with its own {@code flighttracker.confirmation.<id>.enabled}
 *       flag (default false) and return it from {@link #enabled()}.</li>
 *   <li>Read the API key from an environment variable through
 *       {@code @Value("${flighttracker.confirmation.<id>.api-key:}")} backed by
 *       something like {@code FLIGHTTRACKER_CONFIRMATION_<ID>_API_KEY}. Never
 *       commit a key. The deploy environment sets it from a GitHub secret, and
 *       the README's "Arrival confirmation providers" section lists it.</li>
 *   <li>{@link #covers} is a cheap local check (an airport list), never a call.
 *       It must return false for a null airport unless the provider can
 *       search without one.</li>
 *   <li>{@link #lookup} makes at most one upstream call and maps the response
 *       to a {@link LookupResult}: FOUND with whatever times it has, NOT_FOUND
 *       when the upstream has no such flight yet, THROTTLED (with the
 *       Retry-After if given) on HTTP 429, FAILED for anything else. It
 *       should not throw, and it does no caching, pacing or backoff of its own.</li>
 * </ul>
 * Caching, the minimum call interval, the daily call budget and the backoff
 * live in {@link ConfirmationGateway}, so every provider gets them. A provider
 * only maps requests to responses.
 *
 * <h2>Known limitations</h2>
 * <ul>
 *   <li>The daily call budget is per provider and counts calls, not cost
 *       units: a plan that bills some endpoints at several units per call
 *       needs a lower {@code daily-budget} than its quota.</li>
 *   <li>One call asks about one flight. An airport-level batch API (one call
 *       returning many flights' times, such as Swedavia's) would be used far
 *       below its worth and needs an extension of this interface.</li>
 * </ul>
 */
public interface ArrivalConfirmationProvider {

    /** Short stable identifier, lower case, for example {@code swedavia}. */
    String id();

    /** False while the provider's own enabled flag is off; a disabled provider is never asked. */
    default boolean enabled() {
        return true;
    }

    /** True when this provider has data for arrivals at the airport (ICAO code, may be null if unknown). */
    boolean covers(String arrivalAirportIcao);

    /**
     * One lookup. Called by the gateway, which has already cached, paced and budgeted it.
     * It runs synchronously on the shared scheduler thread, so it blocks every
     * other provider and the rest of the tick while it waits: set HTTP connect
     * and read timeouts (for example 5 s and 10 s, as {@code OpenSkyAgent} does).
     */
    LookupResult lookup(ArrivalQuery query);
}
