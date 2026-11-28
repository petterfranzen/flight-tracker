package com.flighttracker.service;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.HexFormat;

/**
 * The opaque token a client key is tracked and persisted under:
 * {@code HMAC-SHA256(pepper, key)} in lowercase hex (finding M3 of the security
 * audit, section9-hq #405). {@link HotPollUserBudget} keys its in-memory map by
 * this and writes rows as {@code "hotpoll.ip." + value()}, so a raw client IP
 * never lands in the database and the map is not a table of visitor addresses.
 *
 * <p>A blank pepper falls back to a fixed, public key — HMAC needs a non-empty
 * key, and that still keeps the raw IP out of the database — but the real
 * defence is a key only the deployment holds, set via
 * {@code FLIGHTTRACKER_RATE_LIMIT_PEPPER}, as production is.
 */
record ClientKeyToken(String value) {

    private static final byte[] UNKEYED_SECRET = "flight-tracker-unkeyed-ip-hash".getBytes(StandardCharsets.UTF_8);

    static ClientKeyToken of(String pepper, String clientKey) {
        byte[] secret = pepper == null || pepper.isEmpty() ? UNKEYED_SECRET : pepper.getBytes(StandardCharsets.UTF_8);
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret, "HmacSHA256"));
            return new ClientKeyToken(HexFormat.of().formatHex(mac.doFinal(clientKey.getBytes(StandardCharsets.UTF_8))));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("HmacSHA256 is not available", e);
        }
    }
}
