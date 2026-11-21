package com.flighttracker.service;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.HexFormat;
import java.util.regex.Pattern;

/**
 * The opaque token a client key is tracked and persisted under:
 * {@code HMAC-SHA256(pepper, key)} in lowercase hex (finding M3 of the security
 * audit, section9-hq #405). {@link HotPollUserBudget} keys its in-memory map by
 * this and writes rows as {@code "hotpoll.ip." + value()}, so a raw client IP
 * never lands in the database and the map is not a table of visitor addresses.
 *
 * <p>The pepper is required (finding M3 follow-up): HMAC needs a key, and a
 * fixed key committed in this public repository would leave every stored token
 * brute-forceable from the client address alone — the hashing would protect
 * nothing, while looking like it did. There is therefore no fallback: a blank
 * pepper is refused here, and {@link IpHashPepper} is where the deployment's
 * own key is read and checked (a real key, at least
 * {@value #MIN_PEPPER_BYTES} bytes, required under the {@code prod} profile).
 */
record ClientKeyToken(String value) {

    /**
     * Minimum pepper length in bytes. A 256-bit key is the floor for an HMAC
     * whose whole job is to be infeasible to brute-force; the profile subject
     * pepper ({@code SubjectHash}) uses the same minimum.
     */
    static final int MIN_PEPPER_BYTES = 32;

    /** A token this class produces: a 64-lowercase-hex-char SHA-256 HMAC. */
    private static final Pattern TOKEN = Pattern.compile("[0-9a-f]{64}");

    static ClientKeyToken of(String pepper, String clientKey) {
        if (pepper == null || pepper.isBlank()) {
            throw new IllegalArgumentException("the IP-hash pepper must not be blank");
        }
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(pepper.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return new ClientKeyToken(HexFormat.of().formatHex(mac.doFinal(clientKey.getBytes(StandardCharsets.UTF_8))));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("HmacSHA256 is not available", e);
        }
    }

    /**
     * True when {@code s} has the shape of a token this class produces: exactly
     * 64 lowercase hex characters (a SHA-256 HMAC). {@link HotPollUserBudget}
     * uses it at startup to tell a token row from a pre-M3 row keyed by the raw
     * client key — an address is never 64 hex characters — and deletes the
     * latter, which can otherwise never be matched again (finding M3).
     */
    static boolean isToken(String s) {
        return s != null && TOKEN.matcher(s).matches();
    }
}
