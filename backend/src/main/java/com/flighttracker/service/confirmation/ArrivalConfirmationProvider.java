package com.flighttracker.service.confirmation;

import java.time.Duration;

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
 * Caching, the minimum call interval, the budgets and the backoff live in
 * {@link ConfirmationGateway}, so every provider gets them. A provider only
 * maps requests to responses.
 *
 * <h2>Two provider shapes</h2>
 * This interface is the <b>per-flight</b> shape: one call asks about one
 * flight, and the answer is cached by callsign. A source that serves a whole
 * arrivals board per airport and date implements {@link AirportArrivalsProvider}
 * instead: one call then serves every candidate at that airport. Both shapes
 * share the minimum interval, the backoff and the budgets.
 *
 * <h2>Budgets</h2>
 * Budgets are per provider and counted in cost units, not calls, so a quota
 * that bills in units is respected: {@code flighttracker.confirmation.providers.<id>.daily-budget}
 * (default: the global {@code daily-budget}) and {@code .monthly-budget}
 * (default: unlimited) are kept in {@link ConfirmationBudgets}, which persists
 * them in app_state. Each {@link #lookup} charges {@link #callCost()} units.
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

    /**
     * Budget units one {@link #lookup} costs upstream (default 1). Declare 2 for
     * a plan that bills a lookup at two units, so the provider's daily and
     * monthly budgets, which are in units, count it right.
     */
    default int callCost() {
        return 1;
    }

    /**
     * False when the provider's terms do not allow keeping what it returns beyond a short
     * cache. {@link ArrivalConfirmationService} then writes no long-lived training label
     * from its answers (the bounded in-memory caches and the confirmation store are still
     * used). Default true.
     */
    default boolean mayStoreLongTerm() {
        return true;
    }

    /**
     * False for a query this provider can never answer (a callsign its API cannot take,
     * a missing key, a lockout). Checked by the gateway before anything is charged or paced:
     * the answer is then NOT_FOUND, uncached and free, and the caller moves on to its next
     * candidate in the same tick. Must be a cheap local check. Default true.
     */
    default boolean accepts(ArrivalQuery query) {
        return true;
    }

    /**
     * How long a FOUND answer without a gate-in time is kept before the provider is asked
     * again about the same flight. The gateway uses the longer of this and its own default
     * (5 min). Null: the gateway default. A provider that bills a lookup in quota units
     * returns something long, since the gate time rarely changes quickly.
     */
    default Duration foundRecheck() {
        return null;
    }

    /** As {@link #foundRecheck()}, for NOT_FOUND (the gateway default is 15 min). Null: the default. */
    default Duration notFoundRecheck() {
        return null;
    }

    /**
     * How long after a confirmed landing without a gate time this provider keeps being asked
     * for the gate. Null: the global {@code gate-wait-minutes}. Zero: stop asking once the
     * landing is confirmed, for a source that rarely has a distinct in-block time.
     */
    default Duration gateWait() {
        return null;
    }
}
