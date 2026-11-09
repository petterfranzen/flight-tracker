package com.flighttracker.service;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.mock.web.MockHttpServletRequest;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Client-IP resolution (PLAN.md §6 item 7, tightened by security review #143
 * M4): proxy headers are believed only from a trusted socket peer
 * (default: loopback, the cloudflared tunnel); from anyone else the peer
 * address is the identity. isLocal() is a plain IP classification. See
 * AgentControllerTest for the trust-local gate.
 */
class ClientIpResolverTest {

    private final ClientIpResolver resolver = new ClientIpResolver("127.0.0.1,::1");

    private String resolve(String peer, Map<String, String> headers) {
        return resolver.resolve(peer, headers::get);
    }

    @Test
    void trustedPeer_cfConnectingIpWinsOverEveryOtherHeader() {
        assertThat(resolve("127.0.0.1", Map.of("CF-Connecting-IP", "203.0.113.9",
                "X-Real-IP", "198.51.100.1", "X-Forwarded-For", "198.51.100.2"))).isEqualTo("203.0.113.9");
    }

    @Test
    void trustedPeer_xRealIpThenXForwardedFor() {
        assertThat(resolve("127.0.0.1", Map.of("X-Real-IP", "10.0.0.5", "X-Forwarded-For", "198.51.100.2")))
                .isEqualTo("10.0.0.5");
        assertThat(resolve("127.0.0.1", Map.of("X-Forwarded-For", "198.51.100.2"))).isEqualTo("198.51.100.2");
    }

    @Test
    void trustedPeer_xForwardedForIsReadFromTheRight_notTheClientControlledLeft() {
        // client sent "6.6.6.6"; the proxy appended the address it saw
        assertThat(resolve("127.0.0.1", Map.of("X-Forwarded-For", "6.6.6.6, 203.0.113.7"))).isEqualTo("203.0.113.7");
        // trusted hops on the right are skipped
        assertThat(resolve("127.0.0.1", Map.of("X-Forwarded-For", "6.6.6.6, 203.0.113.7, 127.0.0.1")))
                .isEqualTo("203.0.113.7");
    }

    @Test
    void trustedPeer_noHeaders_fallsBackToPeer() {
        assertThat(resolve("127.0.0.1", Map.of())).isEqualTo("127.0.0.1");
        assertThat(resolve("::1", Map.of("CF-Connecting-IP", "  "))).isEqualTo("0:0:0:0:0:0:0:1");
    }

    @Test
    void trustedProxyWithoutClientIpHeaders_keepsThePeerKey_andWarnsOncePerProxyIp() {
        Logger logger = (Logger) LoggerFactory.getLogger(ClientIpResolver.class);
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        logger.addAppender(appender);
        try {
            ClientIpResolver r = new ClientIpResolver("127.0.0.1,10.0.0.0/8");
            for (int i = 0; i < 5; i++) {
                assertThat(r.resolve("127.0.0.1", Map.<String, String>of()::get)).isEqualTo("127.0.0.1");
            }
            assertThat(r.resolve("10.1.2.3", Map.<String, String>of()::get)).isEqualTo("10.1.2.3");
            assertThat(r.resolve("10.1.2.3", Map.of("X-Forwarded-For", "garbage")::get)).isEqualTo("10.1.2.3");
            // a second proxy IP warns separately; a proxy that does send a header never warns
            assertThat(r.resolve("10.9.9.9", Map.of("CF-Connecting-IP", "203.0.113.9")::get)).isEqualTo("203.0.113.9");

            assertThat(appender.list).hasSize(2);
            assertThat(appender.list).allSatisfy(e -> assertThat(e.getLevel()).isEqualTo(Level.WARN));
            assertThat(appender.list.get(0).getFormattedMessage()).contains("127.0.0.1");
            assertThat(appender.list.get(1).getFormattedMessage()).contains("10.1.2.3");
        } finally {
            logger.detachAppender(appender);
        }
    }

    @Test
    void untrustedPeerWithoutHeaders_isNotAProxy_soNeverWarns() {
        Logger logger = (Logger) LoggerFactory.getLogger(ClientIpResolver.class);
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        logger.addAppender(appender);
        try {
            assertThat(resolve("192.0.2.1", Map.of())).isEqualTo("192.0.2.1");
            assertThat(resolve("192.0.2.1", Map.of("CF-Connecting-IP", "203.0.113.9"))).isEqualTo("192.0.2.1");
            assertThat(appender.list).isEmpty();
        } finally {
            logger.detachAppender(appender);
        }
    }

    @Test
    void untrustedPeer_ignoresEveryProxyHeader() {
        assertThat(resolve("192.0.2.1", Map.of("CF-Connecting-IP", "203.0.113.9", "X-Real-IP", "10.0.0.5",
                "X-Forwarded-For", "203.0.113.7"))).isEqualTo("192.0.2.1");
    }

    @Test
    void rotatingSpoofedHeadersFromAnUntrustedPeerKeepOneKey() {
        for (int i = 1; i <= 50; i++) {
            assertThat(resolve("192.0.2.1", Map.of("X-Forwarded-For", "203.0.113." + i,
                    "CF-Connecting-IP", "198.51.100." + i))).isEqualTo("192.0.2.1");
        }
    }

    @Test
    void headerValuesThatAreNotIpLiteralsAreIgnored() {
        assertThat(resolve("127.0.0.1", Map.of("CF-Connecting-IP", "evil.example", "X-Real-IP", "999.1.1.1",
                "X-Forwarded-For", "not-an-ip"))).isEqualTo("127.0.0.1");
        // a garbage hop stops the right-to-left walk instead of being skipped past
        assertThat(resolve("127.0.0.1", Map.of("X-Forwarded-For", "6.6.6.6, garbage, 127.0.0.1")))
                .isEqualTo("127.0.0.1");
    }

    @Test
    void ipv6AndMappedAddressesAreCanonicalised() {
        assertThat(resolve("127.0.0.1", Map.of("CF-Connecting-IP", "2001:db8::1")))
                .isEqualTo(resolve("127.0.0.1", Map.of("CF-Connecting-IP", "2001:0DB8:0:0:0:0:0:1")));
        assertThat(resolve("::ffff:127.0.0.1", Map.of("CF-Connecting-IP", "203.0.113.9"))).isEqualTo("203.0.113.9");
    }

    @Test
    void nullOrBlankPeerIsUnknown() {
        assertThat(resolve(null, Map.of("CF-Connecting-IP", "203.0.113.9"))).isEqualTo("unknown");
        assertThat(resolve(" ", Map.of())).isEqualTo("unknown");
    }

    @Test
    void trustedProxiesAreConfigurable_exactIpsAndCidrs() {
        ClientIpResolver custom = new ClientIpResolver(" 10.1.2.3 , 172.16.0.0/12, fd00::/8 ");
        assertThat(custom.isTrustedProxy("10.1.2.3")).isTrue();
        assertThat(custom.isTrustedProxy("10.1.2.4")).isFalse();
        assertThat(custom.isTrustedProxy("172.31.255.255")).isTrue();
        assertThat(custom.isTrustedProxy("172.32.0.1")).isFalse();
        assertThat(custom.isTrustedProxy("fd12::1")).isTrue();
        assertThat(custom.isTrustedProxy("127.0.0.1")).isFalse(); // loopback is not implied
        assertThat(custom.resolve("10.1.2.3", Map.of("CF-Connecting-IP", "203.0.113.9")::get)).isEqualTo("203.0.113.9");
        assertThat(custom.resolve("127.0.0.1", Map.of("CF-Connecting-IP", "203.0.113.9")::get)).isEqualTo("127.0.0.1");
    }

    @Test
    void emptyTrustedList_trustsNoHeadersAtAll() {
        ClientIpResolver none = new ClientIpResolver("");
        assertThat(none.resolve("127.0.0.1", Map.of("CF-Connecting-IP", "203.0.113.9")::get)).isEqualTo("127.0.0.1");
    }

    @Test
    void badTrustedProxyConfigFailsAtStartup() {
        assertThatThrownBy(() -> new ClientIpResolver("localhost")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ClientIpResolver("10.0.0.0/33")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ClientIpResolver("10.0.0.0/x")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void resolvesFromAnHttpServletRequest() {
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.setRemoteAddr("127.0.0.1");
        request.addHeader("CF-Connecting-IP", "203.0.113.9");
        assertThat(resolver.resolve(request)).isEqualTo("203.0.113.9");

        request.setRemoteAddr("192.0.2.1");
        assertThat(resolver.resolve(request)).isEqualTo("192.0.2.1");
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
