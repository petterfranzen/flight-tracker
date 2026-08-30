package com.flighttracker.service;

import jakarta.servlet.http.HttpServletRequest;

import java.net.InetAddress;
import java.net.UnknownHostException;

/**
 * Determines the real client IP for a request — every request that
 * actually reaches this container arrives either via our own nginx (see
 * frontend/nginx.conf, which sets X-Real-IP to $remote_addr) or, in
 * development, directly against backend-api's published port with no
 * proxy in front at all. X-Real-IP is trusted here specifically because
 * nginx is *our own* reverse proxy, not an arbitrary untrusted
 * intermediary — see isLocal's note if a public-facing proxy is ever
 * added in front of it.
 */
public final class ClientIpResolver {

    private ClientIpResolver() {
    }

    public static String resolve(HttpServletRequest request) {
        String xRealIp = request.getHeader("X-Real-IP");
        if (xRealIp != null && !xRealIp.isBlank()) return xRealIp.trim();
        String xForwardedFor = request.getHeader("X-Forwarded-For");
        if (xForwardedFor != null && !xForwardedFor.isBlank()) {
            return xForwardedFor.split(",")[0].trim();
        }
        return request.getRemoteAddr();
    }

    /**
     * True for loopback and RFC1918/link-local addresses — covers literal
     * localhost, the docker-compose bridge network nginx proxies through
     * (so a developer's own browser hitting the real frontend still
     * counts as local), and — deliberately — anyone on the same LAN as a
     * home/NAS deployment, per the request to consider a local-network
     * exception. Not a security boundary against a spoofed X-Real-IP from
     * a malicious proxy in front of nginx — there isn't one in this
     * deployment (see docker-compose.yml / deploy/), so that's not a real
     * exposure today, but this trust assumption should be revisited if a
     * public-facing reverse proxy is ever added in front of nginx.
     */
    public static boolean isLocal(String ip) {
        try {
            InetAddress addr = InetAddress.getByName(ip);
            return addr.isLoopbackAddress() || addr.isSiteLocalAddress() || addr.isLinkLocalAddress();
        } catch (UnknownHostException e) {
            // Not a real DNS lookup for an IP literal (getByName parses it
            // directly), so this only fires for a genuinely malformed
            // value — treat as non-local rather than fail the request.
            return false;
        }
    }
}
