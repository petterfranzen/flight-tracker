package com.flighttracker.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.env.Environment;
import org.springframework.core.env.Profiles;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.HexFormat;

/**
 * Resolves the pepper {@link ClientKeyToken} keys its HMACs with, from
 * {@code flighttracker.rate-limit.ip-hash-pepper}
 * ({@code FLIGHTTRACKER_RATE_LIMIT_PEPPER} in the VM's
 * {@code /etc/flight-tracker/env}, never in this repository).
 *
 * <p>There is no fallback key. A fixed one committed in this public repository
 * would leave every persisted budget token brute-forceable from the client
 * address alone — the hashing would give a false sense of privacy — so a
 * {@code prod}-profile run with no pepper refuses to start, and any other run
 * (local, dev, tests) logs one warning and derives a fresh random key for the
 * life of that process: enough to keep the raw address out of the database
 * where nothing has to survive a restart, and never a value anyone else holds.
 *
 * <p>A configured pepper shorter than {@link ClientKeyToken#MIN_PEPPER_BYTES}
 * bytes is refused outright, under any profile: a short key is brute-forceable
 * and worse than an obviously absent one.
 */
@Component
class IpHashPepper {

    private static final Logger log = LoggerFactory.getLogger(IpHashPepper.class);

    private final String value;

    IpHashPepper(@Value("${flighttracker.rate-limit.ip-hash-pepper:}") String configured, Environment env) {
        String pepper = configured == null ? "" : configured.trim();
        if (pepper.isEmpty()) {
            this.value = resolveMissing(env);
        } else if (pepper.getBytes(StandardCharsets.UTF_8).length < ClientKeyToken.MIN_PEPPER_BYTES) {
            throw new IllegalStateException("flighttracker.rate-limit.ip-hash-pepper "
                    + "(FLIGHTTRACKER_RATE_LIMIT_PEPPER) must be at least "
                    + ClientKeyToken.MIN_PEPPER_BYTES + " bytes");
        } else {
            this.value = pepper;
        }
    }

    /** A missing pepper is fatal under {@code prod}, a one-line warning anywhere else. */
    private static String resolveMissing(Environment env) {
        if (env.acceptsProfiles(Profiles.of("prod"))) {
            throw new IllegalStateException("flighttracker.rate-limit.ip-hash-pepper "
                    + "(FLIGHTTRACKER_RATE_LIMIT_PEPPER) must be set under the prod profile: "
                    + "without it the persisted per-client budget tokens are not keyed");
        }
        log.warn("flighttracker.rate-limit.ip-hash-pepper (FLIGHTTRACKER_RATE_LIMIT_PEPPER) is not set: "
                + "deriving a random one for this run, so the persisted per-client budget history "
                + "will not survive a restart");
        return randomPepper();
    }

    private static String randomPepper() {
        byte[] bytes = new byte[ClientKeyToken.MIN_PEPPER_BYTES];
        new SecureRandom().nextBytes(bytes);
        return HexFormat.of().formatHex(bytes);
    }

    /** The effective pepper: never blank, always at least {@link ClientKeyToken#MIN_PEPPER_BYTES} bytes. */
    String value() {
        return value;
    }
}
