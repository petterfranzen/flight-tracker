package com.flighttracker.service;

import org.junit.jupiter.api.Test;

import java.net.InetAddress;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class TrustedProxiesTest {

    @Test
    void matchesExactAddressesAndCidrs() {
        TrustedProxies proxies = TrustedProxies.parse(" 127.0.0.1 , ,10.0.0.0/8, 192.168.1.128/25, ::1, 2001:db8::/32");
        assertThat(proxies.contains(ip("127.0.0.1"))).isTrue();
        assertThat(proxies.contains(ip("127.0.0.2"))).isFalse();
        assertThat(proxies.contains(ip("10.200.3.4"))).isTrue();
        assertThat(proxies.contains(ip("11.0.0.1"))).isFalse();
        assertThat(proxies.contains(ip("192.168.1.200"))).isTrue();
        assertThat(proxies.contains(ip("192.168.1.100"))).isFalse();
        assertThat(proxies.contains(ip("::1"))).isTrue();
        assertThat(proxies.contains(ip("2001:db8:ffff::1"))).isTrue();
        assertThat(proxies.contains(ip("2001:db9::1"))).isFalse();
    }

    @Test
    void zeroPrefixMatchesTheWholeFamilyOnly() {
        TrustedProxies proxies = TrustedProxies.parse("0.0.0.0/0");
        assertThat(proxies.contains(ip("8.8.8.8"))).isTrue();
        assertThat(proxies.contains(ip("::1"))).isFalse();
    }

    @Test
    void emptySettingTrustsNobody() {
        assertThat(TrustedProxies.parse("").contains(ip("127.0.0.1"))).isFalse();
    }

    @Test
    void rejectsBadEntries() {
        assertThatThrownBy(() -> TrustedProxies.parse("proxy.example.com"))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("not an IP or CIDR");
        assertThatThrownBy(() -> TrustedProxies.parse("10.0.0.0/33"))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("bad prefix length");
        assertThatThrownBy(() -> TrustedProxies.parse("::1/129"))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("bad prefix length");
        assertThatThrownBy(() -> TrustedProxies.parse("10.0.0.0/-1"))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("bad prefix length");
        assertThatThrownBy(() -> TrustedProxies.parse("10.0.0.0/x"))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("bad prefix length");
    }

    private static InetAddress ip(String literal) {
        return IpLiterals.parse(literal);
    }
}
