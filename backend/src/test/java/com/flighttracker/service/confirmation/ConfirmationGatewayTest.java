package com.flighttracker.service.confirmation;

import com.flighttracker.service.confirmation.ConfirmationGateway.Kind;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;

import static org.assertj.core.api.Assertions.assertThat;

/** Pacing, budget, backoff and cache of the gateway, with a clock the test moves. */
class ConfirmationGatewayTest {

    /** A provider whose next answers the test scripts, counting its calls. */
    private static final class ScriptedProvider implements ArrivalConfirmationProvider {
        final String id;
        final List<ArrivalQuery> calls = new ArrayList<>();
        Function<ArrivalQuery, LookupResult> answer = q -> LookupResult.notFound();

        ScriptedProvider(String id) {
            this.id = id;
        }

        @Override public String id() { return id; }
        @Override public boolean covers(String airport) { return true; }
        @Override public LookupResult lookup(ArrivalQuery query) {
            calls.add(query);
            return answer.apply(query);
        }
    }

    private TestClock clock;
    private ScriptedProvider provider;
    private Instant landed;

    @BeforeEach
    void setUp() {
        clock = new TestClock();
        provider = new ScriptedProvider("p1");
        landed = clock.instant();
    }

    private ConfirmationGateway gateway(int dailyBudget, int maxCache) {
        return new ConfirmationGateway(clock, 30, dailyBudget, maxCache, 300, 60);
    }

    private ArrivalQuery query(String callsign) {
        return new ArrivalQuery("abc123", callsign, "ESSA", landed);
    }

    private static LookupResult found(Instant on, Instant in) {
        return LookupResult.found(new ArrivalInfo(null, null, on, in, in == null ? null : "B14", null, "ESSA"));
    }

    @Test
    void secondAskForTheSameFlight_isServedFromTheCache_withoutACall() {
        ConfirmationGateway gw = gateway(300, 100);
        provider.answer = q -> found(landed, null);

        ConfirmationGateway.Outcome first = gw.lookup(provider, query("SAS123"));
        ConfirmationGateway.Outcome second = gw.lookup(provider, query("sas123 "));

        assertThat(first.kind()).isEqualTo(Kind.CALLED);
        assertThat(second.kind()).isEqualTo(Kind.CACHED);
        assertThat(second.result().info().actualOn()).isEqualTo(landed);
        assertThat(provider.calls).hasSize(1);
    }

    @Test
    void cacheKey_includesProvider_airport_andUtcDate() {
        ConfirmationGateway gw = gateway(300, 100);
        ScriptedProvider other = new ScriptedProvider("p2");

        gw.lookup(provider, query("SAS123"));
        clock.advance(Duration.ofSeconds(31));
        assertThat(gw.lookup(other, query("SAS123")).kind()).isEqualTo(Kind.CALLED);
        clock.advance(Duration.ofSeconds(31));
        assertThat(gw.lookup(provider, new ArrivalQuery("abc123", "SAS123", "ESGG", landed)).kind()).isEqualTo(Kind.CALLED);
        clock.advance(Duration.ofSeconds(31));
        assertThat(gw.lookup(provider, new ArrivalQuery("abc123", "SAS123", "ESSA", landed.plus(Duration.ofDays(1)))).kind())
                .isEqualTo(Kind.CALLED);
    }

    @Test
    void foundWithoutGateIn_isCachedFiveMinutes() {
        ConfirmationGateway gw = gateway(300, 100);
        provider.answer = q -> found(landed, null);
        gw.lookup(provider, query("SAS123"));

        clock.advance(Duration.ofMinutes(5).minusSeconds(1));
        assertThat(gw.lookup(provider, query("SAS123")).kind()).isEqualTo(Kind.CACHED);
        clock.advance(Duration.ofSeconds(2));
        assertThat(gw.lookup(provider, query("SAS123")).kind()).isEqualTo(Kind.CALLED);
    }

    @Test
    void foundWithGateIn_isCachedTwelveHours() {
        ConfirmationGateway gw = gateway(300, 100);
        provider.answer = q -> found(landed, landed.plusSeconds(480));
        gw.lookup(provider, query("SAS123"));

        clock.advance(Duration.ofHours(12).minusSeconds(1));
        assertThat(gw.lookup(provider, query("SAS123")).kind()).isEqualTo(Kind.CACHED);
        clock.advance(Duration.ofSeconds(2));
        assertThat(gw.lookup(provider, query("SAS123")).kind()).isEqualTo(Kind.CALLED);
    }

    @Test
    void notFound_isCachedFifteenMinutes() {
        ConfirmationGateway gw = gateway(300, 100);
        gw.lookup(provider, query("SAS123"));

        clock.advance(Duration.ofMinutes(15).minusSeconds(1));
        ConfirmationGateway.Outcome cached = gw.lookup(provider, query("SAS123"));
        assertThat(cached.kind()).isEqualTo(Kind.CACHED);
        assertThat(cached.result().status()).isEqualTo(LookupResult.Status.NOT_FOUND);
        clock.advance(Duration.ofSeconds(2));
        assertThat(gw.lookup(provider, query("SAS123")).kind()).isEqualTo(Kind.CALLED);
    }

    @Test
    void ttlByOutcome() {
        assertThat(ConfirmationGateway.ttl(LookupResult.notFound())).isEqualTo(Duration.ofMinutes(15));
        assertThat(ConfirmationGateway.ttl(found(landed, null))).isEqualTo(Duration.ofMinutes(5));
        assertThat(ConfirmationGateway.ttl(found(landed, landed))).isEqualTo(Duration.ofHours(12));
    }

    @Test
    void minimumInterval_skipsACallTooSoon_withoutCountingAFailure() {
        ConfirmationGateway gw = gateway(300, 100);
        gw.lookup(provider, query("SAS123"));

        clock.advance(Duration.ofSeconds(29));
        assertThat(gw.lookup(provider, query("SAS456")).kind()).isEqualTo(Kind.SKIPPED);
        assertThat(provider.calls).hasSize(1);

        clock.advance(Duration.ofSeconds(1));
        assertThat(gw.lookup(provider, query("SAS456")).kind()).isEqualTo(Kind.CALLED);
    }

    @Test
    void theIntervalIsPerProvider() {
        ConfirmationGateway gw = gateway(300, 100);
        gw.lookup(provider, query("SAS123"));

        assertThat(gw.lookup(new ScriptedProvider("p2"), query("SAS123")).kind()).isEqualTo(Kind.CALLED);
    }

    @Test
    void cachedAnswers_doNotUseTheIntervalOrTheBudget() {
        ConfirmationGateway gw = gateway(1, 100);
        gw.lookup(provider, query("SAS123"));

        assertThat(gw.lookup(provider, query("SAS123")).kind()).isEqualTo(Kind.CACHED);
        assertThat(gw.callsToday("p1")).isEqualTo(1);
    }

    @Test
    void dailyBudget_stopsCalls_andResetsAtUtcMidnight() {
        ConfirmationGateway gw = gateway(2, 100);
        clock.set(Instant.parse("2026-10-12T10:00:00Z"));
        landed = clock.instant();

        assertThat(gw.lookup(provider, query("A1")).kind()).isEqualTo(Kind.CALLED);
        clock.advance(Duration.ofMinutes(1));
        assertThat(gw.lookup(provider, query("A2")).kind()).isEqualTo(Kind.CALLED);
        clock.advance(Duration.ofMinutes(1));
        assertThat(gw.lookup(provider, query("A3")).kind()).isEqualTo(Kind.SKIPPED);
        assertThat(gw.callsToday("p1")).isEqualTo(2);
        assertThat(provider.calls).hasSize(2);

        clock.set(Instant.parse("2026-10-13T00:00:30Z"));
        assertThat(gw.lookup(provider, new ArrivalQuery("abc123", "A3", "ESSA", clock.instant())).kind()).isEqualTo(Kind.CALLED);
        assertThat(gw.callsToday("p1")).isEqualTo(1);
    }

    @Test
    void throttled_honoursRetryAfter_andIsNotCached() {
        ConfirmationGateway gw = gateway(300, 100);
        provider.answer = q -> LookupResult.throttled(Duration.ofMinutes(10));

        ConfirmationGateway.Outcome first = gw.lookup(provider, query("SAS123"));
        assertThat(first.kind()).isEqualTo(Kind.CALLED);
        assertThat(first.result().status()).isEqualTo(LookupResult.Status.THROTTLED);

        clock.advance(Duration.ofMinutes(9));
        assertThat(gw.lookup(provider, query("SAS123")).kind()).isEqualTo(Kind.SKIPPED);
        clock.advance(Duration.ofMinutes(2));
        provider.answer = q -> found(landed, null);
        assertThat(gw.lookup(provider, query("SAS123")).kind()).isEqualTo(Kind.CALLED);
        assertThat(provider.calls).hasSize(2);
    }

    @Test
    void failed_coolsDownForTheMinimumBackoff_thenTriesAgain() {
        ConfirmationGateway gw = gateway(300, 100);
        provider.answer = q -> LookupResult.failed();

        assertThat(gw.lookup(provider, query("SAS123")).kind()).isEqualTo(Kind.CALLED);
        clock.advance(Duration.ofSeconds(29));
        assertThat(gw.lookup(provider, query("SAS123")).kind()).isEqualTo(Kind.SKIPPED);
        clock.advance(Duration.ofSeconds(2));
        assertThat(gw.lookup(provider, query("SAS123")).kind()).isEqualTo(Kind.CALLED);
        assertThat(provider.calls).hasSize(2);
    }

    @Test
    void aProviderThatThrows_isTreatedAsFailed() {
        ConfirmationGateway gw = gateway(300, 100);
        provider.answer = q -> {
            throw new IllegalStateException("boom");
        };

        ConfirmationGateway.Outcome o = gw.lookup(provider, query("SAS123"));

        assertThat(o.kind()).isEqualTo(Kind.CALLED);
        assertThat(o.result().status()).isEqualTo(LookupResult.Status.FAILED);
    }

    @Test
    void aCachedLandingFromAnEarlierLeg_isAMiss_soTheLaterLegGetsAFreshLookup() {
        ConfirmationGateway gw = gateway(300, 100);
        clock.set(Instant.parse("2026-10-12T10:00:00Z")); // mid-day, so +3 h stays on the same UTC date
        landed = clock.instant();
        provider.answer = q -> found(q.expectedArrivalAt(), q.expectedArrivalAt().plusSeconds(480));
        gw.lookup(provider, query("SES1")); // landed at `landed`, with a gate: cached 12 h

        // the same callsign and airport lands again 90 minutes later
        clock.advance(Duration.ofMinutes(90));
        Instant later = landed.plus(Duration.ofMinutes(90));
        ConfirmationGateway.Outcome second = gw.lookup(provider, new ArrivalQuery("abc123", "SES1", "ESSA", later));

        assertThat(second.kind()).isEqualTo(Kind.CALLED);
        assertThat(second.result().info().actualOn()).isEqualTo(later);
        assertThat(provider.calls).hasSize(2);
        // and now the entry is the new leg's
        assertThat(gw.lookup(provider, new ArrivalQuery("abc123", "SES1", "ESSA", later)).kind()).isEqualTo(Kind.CACHED);
    }

    @Test
    void aLandingWithinTheSkewTolerance_isStillAHit() {
        ConfirmationGateway gw = gateway(300, 100);
        clock.set(Instant.parse("2026-10-12T10:00:00Z")); // mid-day, so +3 h stays on the same UTC date
        landed = clock.instant();
        provider.answer = q -> found(q.expectedArrivalAt().minusSeconds(240), null);
        gw.lookup(provider, query("SAS123"));

        clock.advance(Duration.ofMinutes(1));
        assertThat(gw.lookup(provider, query("SAS123")).kind()).isEqualTo(Kind.CACHED);
    }

    @Test
    void anEarlierLegAnswer_isReCheckedAtMostEveryFiveMinutes() {
        ConfirmationGateway gw = gateway(300, 100);
        clock.set(Instant.parse("2026-10-12T10:00:00Z")); // mid-day, so +3 h stays on the same UTC date
        landed = clock.instant();
        // a provider that keeps answering with the old leg
        provider.answer = q -> found(landed, landed.plusSeconds(480));
        Instant later = landed.plus(Duration.ofHours(3));
        ArrivalQuery laterQuery = new ArrivalQuery("abc123", "SES1", "ESSA", later);
        gw.lookup(provider, query("SES1"));

        clock.advance(Duration.ofHours(3)); // old entry is stale: one fresh lookup, same old answer
        assertThat(gw.lookup(provider, laterQuery).kind()).isEqualTo(Kind.CALLED);
        clock.advance(Duration.ofMinutes(2));
        assertThat(gw.lookup(provider, laterQuery).kind()).isEqualTo(Kind.CACHED);
        clock.advance(Duration.ofMinutes(4));
        assertThat(gw.lookup(provider, laterQuery).kind()).isEqualTo(Kind.CALLED);
        assertThat(provider.calls).hasSize(3);
    }

    @Test
    void aHugeRetryAfter_isCapped() {
        ConfirmationGateway gw = gateway(300, 100);
        provider.answer = q -> LookupResult.throttled(Duration.ofDays(2));
        gw.lookup(provider, query("SAS123"));

        clock.advance(Duration.ofMinutes(59));
        assertThat(gw.lookup(provider, query("SAS123")).kind()).isEqualTo(Kind.SKIPPED);
        clock.advance(Duration.ofMinutes(2));
        provider.answer = q -> found(landed, null);
        assertThat(gw.lookup(provider, query("SAS123")).kind()).isEqualTo(Kind.CALLED);
    }

    @Test
    void cacheIsBounded() {
        ConfirmationGateway gw = gateway(1000, 3);
        for (int i = 0; i < 6; i++) {
            gw.lookup(provider, query("F" + i));
            clock.advance(Duration.ofSeconds(31));
        }

        assertThat(gw.cacheSize()).isEqualTo(3);
    }
}
