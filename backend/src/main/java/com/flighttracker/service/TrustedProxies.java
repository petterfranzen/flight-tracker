package com.flighttracker.service;

import java.net.InetAddress;
import java.util.ArrayList;
import java.util.List;

/**
 * The proxies whose client-IP headers ClientIpResolver believes
 * ({@code flighttracker.proxy.trusted-proxies}): exact IPs or CIDRs.
 */
final class TrustedProxies {

    private final List<Cidr> ranges;

    private TrustedProxies(List<Cidr> ranges) {
        this.ranges = ranges;
    }

    /** True when the address is inside any trusted range (same address family only). */
    boolean contains(InetAddress addr) {
        byte[] bytes = addr.getAddress();
        for (Cidr cidr : ranges) {
            if (cidr.matches(bytes)) return true;
        }
        return false;
    }

    /** Parses the comma-separated trusted-proxies setting; fails on any entry that is not an IP or CIDR. */
    static TrustedProxies parse(String csv) {
        List<Cidr> out = new ArrayList<>();
        for (String entry : csv.split(",")) {
            String e = entry.trim();
            if (e.isEmpty()) continue;
            out.add(parseCidr(e));
        }
        return new TrustedProxies(List.copyOf(out));
    }

    /** One trusted-proxies entry: an IP literal, optionally with a /prefix length. */
    private static Cidr parseCidr(String e) {
        int slash = e.indexOf('/');
        InetAddress addr = IpLiterals.parse(slash < 0 ? e : e.substring(0, slash));
        if (addr == null) {
            throw new IllegalArgumentException("flighttracker.proxy.trusted-proxies: not an IP or CIDR: " + e);
        }
        byte[] network = addr.getAddress();
        return new Cidr(network, slash < 0 ? network.length * 8 : prefixLength(e, network));
    }

    /** The /prefix length of a CIDR entry, within the address family's width. */
    private static int prefixLength(String e, byte[] network) {
        int max = network.length * 8;
        int bits;
        try {
            bits = Integer.parseInt(e.substring(e.indexOf('/') + 1).trim());
        } catch (NumberFormatException ex) {
            bits = -1;
        }
        if (bits < 0 || bits > max) {
            throw new IllegalArgumentException("flighttracker.proxy.trusted-proxies: bad prefix length: " + e);
        }
        return bits;
    }

    private record Cidr(byte[] network, int bits) {
        boolean matches(byte[] addr) {
            if (addr.length != network.length) return false;
            int full = bits / 8;
            for (int i = 0; i < full; i++) {
                if (addr[i] != network[i]) return false;
            }
            int rest = bits % 8;
            if (rest == 0) return true;
            int mask = 0xFF << (8 - rest) & 0xFF;
            return (addr[full] & mask) == (network[full] & mask);
        }
    }
}
