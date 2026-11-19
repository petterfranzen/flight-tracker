package com.flighttracker.service;

import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.UnaryOperator;

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
 *
 * <p>Security review #143 M4 / section9-hq#168: those headers are plain
 * client input unless a proxy we run wrote them. They are therefore read
 * only when the socket peer is a trusted proxy
 * ({@code flighttracker.proxy.trusted-proxies}, default loopback, i.e. the
 * cloudflared tunnel; exact IPs or CIDRs). From any other peer the headers
 * are ignored and the peer address is the identity, so a spoofed
 * {@code X-Forwarded-For} or {@code CF-Connecting-IP} from outside changes
 * nothing. When trusted, {@code X-Forwarded-For} is read right to left (the
 * entry the last trusted hop appended), never the client-controlled
 * leftmost one. Header values that are not IP literals are ignored.
 * HTTP and WebSocket callers share this, so one visitor has one identity.
 *
 * <p>A trusted proxy that sends none of the client-IP headers (or only
 * unusable ones) is keyed by its own peer address, so all its visitors share
 * one identity and one per-IP cap. That is the safe direction (never more
 * allowance, never a spoofable key), but it is almost certainly a
 * misconfigured proxy, so it is logged once at WARN per proxy IP.
 */
@Component
public class ClientIpResolver {

    private static final Logger log = LoggerFactory.getLogger(ClientIpResolver.class);
    /** Bound on the warn-once memory, so a wide trusted CIDR cannot grow it without limit. */
    private static final int MAX_WARNED = 256;

    private final TrustedProxies trustedProxies;
    private final Set<String> warnedProxies = ConcurrentHashMap.newKeySet();

    public ClientIpResolver(@Value("${flighttracker.proxy.trusted-proxies:127.0.0.1,::1}") String trustedProxies) {
        this.trustedProxies = TrustedProxies.parse(trustedProxies);
    }

    /** The client IP of an HTTP request. */
    public String resolve(HttpServletRequest request) {
        return resolve(request.getRemoteAddr(), request::getHeader);
    }

    /**
     * @param peer   the socket peer address (never a header value)
     * @param header looks up a request header by name, null if absent
     */
    public String resolve(String peer, UnaryOperator<String> header) {
        String peerIp = canonical(peer);
        if (peerIp == null) return peer == null || peer.isBlank() ? "unknown" : peer.trim();
        if (!isTrustedProxy(peerIp)) return peerIp;

        String client = clientFromHeaders(header);
        if (client != null) return client;
        warnOnce(peerIp);
        return peerIp;
    }

    /** The client IP a trusted proxy reported, most-specific header first; null when none is usable. */
    private String clientFromHeaders(UnaryOperator<String> header) {
        String cf = canonical(header.apply("CF-Connecting-IP"));
        if (cf != null) return cf;
        String xRealIp = canonical(header.apply("X-Real-IP"));
        if (xRealIp != null) return xRealIp;
        return rightmostUntrustedHop(header.apply("X-Forwarded-For"));
    }

    /** X-Forwarded-For read right to left: the first hop that is not a trusted proxy, or null. */
    private String rightmostUntrustedHop(String xForwardedFor) {
        if (xForwardedFor == null) return null;
        String[] hops = xForwardedFor.split(",");
        for (int i = hops.length - 1; i >= 0; i--) {
            String hop = canonical(hops[i]);
            if (hop == null) return null; // garbage hop: stop trusting anything left of it
            if (!isTrustedProxy(hop)) return hop;
        }
        return null;
    }

    private void warnOnce(String proxyIp) {
        if (warnedProxies.size() < MAX_WARNED && warnedProxies.add(proxyIp)) {
            log.warn("Trusted proxy {} sent no usable client-IP header (CF-Connecting-IP, X-Real-IP, "
                    + "X-Forwarded-For): its visitors share one identity and one per-IP cap", proxyIp);
        }
    }

    public boolean isTrustedProxy(String ip) {
        InetAddress addr = IpLiterals.parse(ip);
        return addr != null && trustedProxies.contains(addr);
    }

    /** Canonical text of an IP literal, or null when the value is not one (never does a DNS lookup). */
    static String canonical(String value) {
        InetAddress addr = IpLiterals.parse(value);
        return addr == null ? null : addr.getHostAddress();
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
