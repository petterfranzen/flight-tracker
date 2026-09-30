package com.flighttracker.service;

import jakarta.servlet.http.HttpServletRequest;

import java.net.InetAddress;
import java.net.UnknownHostException;

/**
 * Determines the real client IP for a request.
 *
 * Cloud migration security fix (PLAN.md §6 item 7): in production every
 * request now arrives from cloudflared (the Cloudflare Tunnel daemon) on
 * 127.0.0.1 — nginx and its own X-Real-IP-from-$remote_addr setup are gone.
 * Trusting X-Real-IP or the raw remote address here in that world would
 * mean every real visitor's request looks local (both would say
 * 127.0.0.1), silently exempting *everyone* from the rate limits below —
 * the exact failure mode this fix closes. Cloudflare's own edge sets
 * CF-Connecting-IP to the visitor's true IP on every request it proxies,
 * so that's checked first; X-Real-IP and X-Forwarded-For remain as
 * fallbacks for a non-Cloudflare deployment (e.g. running locally behind
 * a different reverse proxy, or bare), in the same priority order a
 * typical proxy chain would set them, most-specific first. Bare
 * getRemoteAddr() is the last resort, for no proxy at all.
 */
public final class ClientIpResolver {

    private ClientIpResolver() {
    }

    public static String resolve(HttpServletRequest request) {
        String cfConnectingIp = request.getHeader("CF-Connecting-IP");
        if (cfConnectingIp != null && !cfConnectingIp.isBlank()) return cfConnectingIp.trim();
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
     * localhost and, deliberately, anyone on the same LAN as a home/NAS
     * deployment, per the original request to consider a local-network
     * exception.
     *
     * A pure IP classification, with no opinion on whether "local" should
     * actually be trusted right now — see
     * flighttracker.rate-limit.trust-local (wired into AgentController,
     * not here) for that. Before the cloud migration, isLocal alone was
     * the exemption: fine when the untrusted-proxy risk this javadoc used
     * to warn about was hypothetical. It stopped being hypothetical the
     * moment cloudflared started fronting every request from 127.0.0.1 —
     * without trust-local defaulting to false in production, *every*
     * request would satisfy isLocal() (resolve() would have nothing
     * better than a loopback address to return if it trusted the wrong
     * header) and rate limiting would be silently off for the whole
     * internet. trust-local exists so dev/local testing can still opt
     * back into the exemption (TRUST_LOCAL=true) without that being the
     * production default.
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
