package com.flighttracker.service;

import jakarta.servlet.http.HttpServletRequest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.when;

/**
 * Covers the cloud migration's client-IP security fix (PLAN.md §6 item 7):
 * resolve()'s header priority (CF-Connecting-IP first — the header
 * Cloudflare Tunnel actually sets — then X-Real-IP, then
 * X-Forwarded-For, then the raw remote address), and isLocal()'s plain IP
 * classification. See AgentControllerTest for the trust-local gate that
 * decides whether isLocal() is even consulted.
 */
@ExtendWith(MockitoExtension.class)
class ClientIpResolverTest {

    @Mock
    private HttpServletRequest request;

    @Test
    void cfConnectingIp_takesPriorityOverEveryOtherHeader() {
        // resolve() short-circuits on the first non-blank header, so
        // X-Real-IP/X-Forwarded-For are never even read once
        // CF-Connecting-IP is present — nothing to stub for them.
        when(request.getHeader("CF-Connecting-IP")).thenReturn("203.0.113.9");

        assertThat(ClientIpResolver.resolve(request)).isEqualTo("203.0.113.9");
    }

    @Test
    void xRealIp_usedWhenNoCfConnectingIp() {
        when(request.getHeader("CF-Connecting-IP")).thenReturn(null);
        when(request.getHeader("X-Real-IP")).thenReturn("10.0.0.5");

        assertThat(ClientIpResolver.resolve(request)).isEqualTo("10.0.0.5");
    }

    @Test
    void xForwardedFor_usedWhenNeitherCfConnectingIpNorXRealIpPresent_firstEntryOnly() {
        when(request.getHeader("CF-Connecting-IP")).thenReturn(null);
        when(request.getHeader("X-Real-IP")).thenReturn(null);
        when(request.getHeader("X-Forwarded-For")).thenReturn("203.0.113.7, 10.0.0.1");

        assertThat(ClientIpResolver.resolve(request)).isEqualTo("203.0.113.7");
    }

    @Test
    void remoteAddr_usedAsLastResort() {
        when(request.getHeader("CF-Connecting-IP")).thenReturn(null);
        when(request.getHeader("X-Real-IP")).thenReturn(null);
        when(request.getHeader("X-Forwarded-For")).thenReturn(null);
        when(request.getRemoteAddr()).thenReturn("192.0.2.1");

        assertThat(ClientIpResolver.resolve(request)).isEqualTo("192.0.2.1");
    }

    @Test
    void blankHeaders_treatedAsAbsentAndFallThrough() {
        when(request.getHeader("CF-Connecting-IP")).thenReturn("  ");
        when(request.getHeader("X-Real-IP")).thenReturn("");
        when(request.getHeader("X-Forwarded-For")).thenReturn(null);
        when(request.getRemoteAddr()).thenReturn("192.0.2.1");

        assertThat(ClientIpResolver.resolve(request)).isEqualTo("192.0.2.1");
    }

    @Test
    void isLocal_trueForLoopback() {
        assertThat(ClientIpResolver.isLocal("127.0.0.1")).isTrue();
    }

    @Test
    void isLocal_trueForPrivateRange() {
        assertThat(ClientIpResolver.isLocal("192.168.1.50")).isTrue();
        assertThat(ClientIpResolver.isLocal("10.0.0.5")).isTrue();
    }

    @Test
    void isLocal_falseForPublicAddress() {
        assertThat(ClientIpResolver.isLocal("203.0.113.9")).isFalse();
    }

    @Test
    void isLocal_falseForMalformedInput() {
        assertThat(ClientIpResolver.isLocal("not-an-ip")).isFalse();
    }
}
