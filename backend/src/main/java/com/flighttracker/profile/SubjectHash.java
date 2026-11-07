package com.flighttracker.profile;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Objects;

/**
 * The one place the OAuth/OIDC subject id is turned into what the database
 * stores. Design §2: only the provider and a *hashed* subject are kept — no
 * email, no name, no avatar — so the raw `sub` never reaches a column.
 *
 * The hash is {@code SHA-256(provider || ':' || subject)}, lowercase hex. The
 * provider is folded in so the same subject string from two different
 * providers cannot collide, and the hex output is a plain 64-char string the
 * {@code profile.subject_hash} column (and its unique index with provider)
 * compares exactly.
 *
 * A plain SHA-256, not a password hash with a salt: the input is a
 * provider-issued id (high entropy, not guessable), and the value must stay
 * deterministic for the {@code (provider, subject_hash)} lookup on every
 * login — a per-row salt would make that lookup impossible.
 */
public final class SubjectHash {

    private SubjectHash() {
    }

    public static String of(String provider, String subject) {
        Objects.requireNonNull(provider, "provider");
        Objects.requireNonNull(subject, "subject");
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest((provider + ":" + subject).getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(hash);
        } catch (NoSuchAlgorithmException e) {
            // SHA-256 is required of every JRE; if it is missing something is
            // badly wrong and failing loudly is correct.
            throw new IllegalStateException("SHA-256 is not available", e);
        }
    }
}
