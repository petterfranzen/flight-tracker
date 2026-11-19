package com.flighttracker.service;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class IpLiteralsTest {

    @Test
    void parsesIpv4AndIpv6Literals() {
        assertThat(IpLiterals.parse(" 203.0.113.7 ").getHostAddress()).isEqualTo("203.0.113.7");
        assertThat(IpLiterals.parse("2001:db8::1").getHostAddress()).isEqualTo("2001:db8:0:0:0:0:0:1");
        assertThat(IpLiterals.parse("fe80::1%eth0").getHostAddress()).isEqualTo("fe80:0:0:0:0:0:0:1");
    }

    @Test
    void rejectsAnythingThatIsNotALiteral() {
        assertThat(IpLiterals.parse(null)).isNull();
        assertThat(IpLiterals.parse("")).isNull();
        assertThat(IpLiterals.parse("localhost")).isNull();
        assertThat(IpLiterals.parse("example.com")).isNull();
        assertThat(IpLiterals.parse("256.1.1.1")).isNull();
        assertThat(IpLiterals.parse("1.2.3")).isNull();
        assertThat(IpLiterals.parse("not:an:ip:zz")).isNull();
    }
}
