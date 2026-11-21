package com.flighttracker.profile;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.HexFormat;
import java.util.Objects;

/**
 * The one place a provider's subject id is turned into what the database
 * stores. Design §2: only the provider and a <i>keyed</i> hash of the subject
 * are kept — no email, no name, no avatar — so the raw {@code sub} never
 * reaches a column.
 *
 * <p>The hash is {@code HMAC-SHA256(pepper, provider || ':' || subject)},
 * lowercase hex, with the pepper read from
 * {@code flighttracker.profile.subject-pepper}
 * ({@code FLIGHTTRACKER_SUBJECT_PEPPER} in the VM's
 * {@code /etc/flight-tracker/env}, never in this repository). The provider is
 * folded in so the same subject string from two providers cannot collide, and
 * the hex output is a plain 64-char string the {@code profile.subject_hash}
 * column (and its unique index with provider) compares exactly.
 *
 * <p>A <b>keyed</b> hash, not a plain SHA-256 (security audit finding M2,
 * section9-hq #405): GitHub ids are small sequential integers, so
 * {@code sha256("github:" + id)} is a dictionary lookup over roughly 2.5e8
 * values — a leaked database would map every profile to a GitHub account on a
 * CPU. The pepper makes the stored value useless to anyone who does not hold
 * it, while staying deterministic for the {@code (provider, subject_hash)}
 * lookup on every login — a per-row salt would make that lookup impossible.
 *
 * <p>Flag-conditional, like {@code ProfileResolver}: with
 * {@code flighttracker.profile.enabled=false} (the default) the bean does not
 * exist at all, so the flag-off app needs no pepper and is unchanged.
 */
@Component
@ConditionalOnProperty(prefix = "flighttracker.profile", name = "enabled", havingValue = "true")
public class SubjectHash {

    /**
     * Minimum pepper length in bytes, matching {@code ClientKeyToken}'s floor
     * for the IP-hash pepper: a 256-bit key is the least an HMAC can use and
     * still be infeasible to brute-force.
     */
    private static final int MIN_PEPPER_BYTES = 32;

    private final byte[] pepper;

    /**
     * @throws IllegalStateException when the pepper is blank. Refusing to start
     *         beats silently hashing subjects with no key at all — the
     *         plain-SHA-256 weakness this class exists to close — and there
     *         are no rows to migrate yet (the flag is off in production).
     */
    public SubjectHash(@Value("${flighttracker.profile.subject-pepper:}") String pepper) {
        if (pepper == null || pepper.isBlank()) {
            throw new IllegalStateException("flighttracker.profile.subject-pepper "
                    + "(FLIGHTTRACKER_SUBJECT_PEPPER) must be set when flighttracker.profile.enabled=true");
        }
        if (pepper.getBytes(StandardCharsets.UTF_8).length < MIN_PEPPER_BYTES) {
            throw new IllegalStateException("flighttracker.profile.subject-pepper "
                    + "(FLIGHTTRACKER_SUBJECT_PEPPER) must be at least " + MIN_PEPPER_BYTES + " bytes");
        }
        this.pepper = pepper.getBytes(StandardCharsets.UTF_8);
    }

    /** The stored subject hash: HMAC-SHA256(pepper, provider || ':' || subject), lowercase hex. */
    public String of(String provider, String subject) {
        Objects.requireNonNull(provider, "provider");
        Objects.requireNonNull(subject, "subject");
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(pepper, "HmacSHA256"));
            byte[] hash = mac.doFinal((provider + ":" + subject).getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(hash);
        } catch (GeneralSecurityException e) {
            // HmacSHA256 is required of every JRE; if it is missing something
            // is badly wrong and failing loudly is correct.
            throw new IllegalStateException("HmacSHA256 is not available", e);
        }
    }
}
