package com.flighttracker.service;

import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.regex.Pattern;

/**
 * Parses IP literals for ClientIpResolver without ever resolving a hostname:
 * only literal-shaped text (IPv4 dotted quads with octets up to 255, or
 * IPv6 characters) reaches InetAddress.getByName. A zone id ({@code %eth0})
 * is dropped.
 */
final class IpLiterals {

    private static final Pattern IPV4 = Pattern.compile("\\d{1,3}(\\.\\d{1,3}){3}");
    private static final Pattern IPV6_CHARS = Pattern.compile("[0-9A-Fa-f:.]{2,45}");

    private IpLiterals() {
    }

    /** The address an IP literal names, or null when the value is not one (never does a DNS lookup). */
    static InetAddress parse(String value) {
        if (value == null) return null;
        String v = value.trim();
        int scope = v.indexOf('%');
        if (scope >= 0) v = v.substring(0, scope);
        // Only literal-shaped text reaches getByName, so it can't resolve a hostname.
        if (!literalShaped(v)) return null;
        try {
            return InetAddress.getByName(v);
        } catch (UnknownHostException e) {
            return null;
        }
    }

    private static boolean literalShaped(String v) {
        if (v.indexOf(':') >= 0) return IPV6_CHARS.matcher(v).matches();
        return IPV4.matcher(v).matches() && octetsInRange(v);
    }

    private static boolean octetsInRange(String ipv4) {
        for (String octet : ipv4.split("\\.")) {
            if (Integer.parseInt(octet) > 255) return false; // else getByName would try DNS
        }
        return true;
    }
}
