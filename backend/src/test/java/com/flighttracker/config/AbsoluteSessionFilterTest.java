package com.flighttracker.config;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.mock.web.MockHttpSession;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Design section9-hq #84, step 3b-1: the absolute session cap. The idle timeout
 * (24h) lets a busy client hold a session open forever; {@link AbsoluteSessionFilter}
 * invalidates any session past {@link AbsoluteSessionFilter#ABSOLUTE_SESSION_CAP}
 * measured from its creation time. The clock is injected, so "31 days later" is
 * exact rather than a 30-day sleep.
 */
class AbsoluteSessionFilterTest {

    private static final Duration CAP = AbsoluteSessionFilter.ABSOLUTE_SESSION_CAP;

    /** A clock reading {@code offset} after the session was created. */
    private static Clock clockAged(MockHttpSession session, Duration offset) {
        return Clock.fixed(Instant.ofEpochMilli(session.getCreationTime()).plus(offset), ZoneOffset.UTC);
    }

    @Test
    void aSessionPastTheCapIsInvalidated() throws Exception {
        MockHttpSession session = new MockHttpSession();
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.setSession(session);

        new AbsoluteSessionFilter(CAP, clockAged(session, Duration.ofDays(31)))
                .doFilter(request, new MockHttpServletResponse(), new MockFilterChain());

        assertThat(session.isInvalid()).as("a session older than 30 days").isTrue();
    }

    @Test
    void aSessionInsideTheCapIsUntouched() throws Exception {
        MockHttpSession session = new MockHttpSession();
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.setSession(session);

        new AbsoluteSessionFilter(CAP, clockAged(session, Duration.ofDays(29)))
                .doFilter(request, new MockHttpServletResponse(), new MockFilterChain());

        assertThat(session.isInvalid()).as("a session inside the cap must survive").isFalse();
    }

    @Test
    void exactlyTheCapIsNotYetExpired() throws Exception {
        MockHttpSession session = new MockHttpSession();
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.setSession(session);

        new AbsoluteSessionFilter(CAP, clockAged(session, CAP))
                .doFilter(request, new MockHttpServletResponse(), new MockFilterChain());

        assertThat(session.isInvalid()).as("the cap is a strict upper bound").isFalse();
    }

    @Test
    void aRequestWithNoSessionIsUntouchedAndPassesThrough() throws Exception {
        MockFilterChain chain = new MockFilterChain();

        new AbsoluteSessionFilter(CAP, Clock.systemUTC())
                .doFilter(new MockHttpServletRequest(), new MockHttpServletResponse(), chain);

        assertThat(chain.getRequest()).as("the filter must not stop the chain").isNotNull();
    }
}
