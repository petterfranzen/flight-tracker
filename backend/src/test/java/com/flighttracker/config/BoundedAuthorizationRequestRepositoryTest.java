package com.flighttracker.config;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.oauth2.core.endpoint.OAuth2AuthorizationRequest;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The pending-authorization-request store (security: section9-hq #404, H3).
 *
 * <p>Its whole job is to keep an anonymous {@code /oauth2/authorization/*} start
 * from touching the session, so the tests below pin the two properties that make
 * that safe to leave running unattended: a request round-trips by {@code state},
 * and the store stays bounded in both count and age.
 */
class BoundedAuthorizationRequestRepositoryTest {

    private static OAuth2AuthorizationRequest request(String state) {
        return OAuth2AuthorizationRequest.authorizationCode()
                .authorizationUri("https://accounts.example.com/o/oauth2/v2/auth")
                .clientId("test-client-id")
                .redirectUri("https://flight.example.com/login/oauth2/code/test")
                .state(state)
                .build();
    }

    /** A request carrying a {@code state} query parameter, as the provider's callback has. */
    private static MockHttpServletRequest callback(String state) {
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.setParameter("state", state);
        return request;
    }

    private static MockHttpServletResponse response() {
        return new MockHttpServletResponse();
    }

    @Test
    void aSavedRequestRoundTripsAndIsConsumedOnce() {
        BoundedAuthorizationRequestRepository repository = new BoundedAuthorizationRequestRepository();
        repository.saveAuthorizationRequest(request("state-1"), callback("state-1"), response());

        assertThat(repository.loadAuthorizationRequest(callback("state-1")))
                .as("the request is readable before the callback consumes it").isNotNull();
        assertThat(repository.removeAuthorizationRequest(callback("state-1"), response()))
                .as("the callback consumes it").isNotNull();
        assertThat(repository.removeAuthorizationRequest(callback("state-1"), response()))
                .as("and only once — a replayed state resolves to nothing").isNull();
    }

    @Test
    void anUnknownStateResolvesToNothing() {
        BoundedAuthorizationRequestRepository repository = new BoundedAuthorizationRequestRepository();
        assertThat(repository.loadAuthorizationRequest(callback("never-saved"))).isNull();
        assertThat(repository.removeAuthorizationRequest(callback("never-saved"), response())).isNull();
        // A request with no state parameter at all must not throw either.
        assertThat(repository.loadAuthorizationRequest(new MockHttpServletRequest())).isNull();
    }

    @Test
    void aCancelledStartClearsThePendingRequest() {
        // Spring calls save(null, ...) to cancel a start; the request must not linger.
        BoundedAuthorizationRequestRepository repository = new BoundedAuthorizationRequestRepository();
        repository.saveAuthorizationRequest(request("state-1"), callback("state-1"), response());
        repository.saveAuthorizationRequest(null, callback("state-1"), response());

        assertThat(repository.loadAuthorizationRequest(callback("state-1"))).isNull();
    }

    @Test
    void theStoreEvictsTheOldestPastItsCap() {
        BoundedAuthorizationRequestRepository repository = new BoundedAuthorizationRequestRepository();
        for (int i = 0; i <= BoundedAuthorizationRequestRepository.MAX_PENDING; i++) {
            String state = "state-" + i;
            repository.saveAuthorizationRequest(request(state), callback(state), response());
        }

        assertThat(repository.loadAuthorizationRequest(callback("state-0")))
                .as("the least-recently-used entry is evicted").isNull();
        assertThat(repository.loadAuthorizationRequest(
                callback("state-" + BoundedAuthorizationRequestRepository.MAX_PENDING)))
                .as("the newest entry is kept").isNotNull();
    }

    @Test
    void aPendingRequestExpiresAfterItsTtl() {
        TestClock clock = new TestClock();
        BoundedAuthorizationRequestRepository repository = new BoundedAuthorizationRequestRepository(clock);
        repository.saveAuthorizationRequest(request("state-1"), callback("state-1"), response());

        clock.advance(BoundedAuthorizationRequestRepository.TTL.plusSeconds(1));

        assertThat(repository.loadAuthorizationRequest(callback("state-1")))
                .as("a request older than the TTL is gone").isNull();
    }

    /** A clock the test moves by hand, so the TTL can be crossed without waiting. */
    private static final class TestClock extends Clock {

        private Instant now = Instant.parse("2026-01-01T00:00:00Z");

        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return now;
        }

        void advance(Duration by) {
            now = now.plus(by);
        }
    }
}
