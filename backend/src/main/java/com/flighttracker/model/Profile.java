package com.flighttracker.model;

import java.time.Instant;

/**
 * One row of the profile table (schema.sql) — a person who chose to sign in.
 *
 * The minimum the sync needs: an opaque id, the provider and a *hashed*
 * subject id. There is deliberately no email, name or avatar (design §2):
 * scope=openid alone means the provider never sends them.
 *
 * `id` is a 128-bit SecureRandom value, base64url, server-side only — it is
 * never derived from the subject, and (from the API, in a later step) never
 * returned to the client, which is identified by its session instead.
 */
public record Profile(
        String id,
        String provider,
        String subjectHash,
        Instant createdAt,
        Instant lastSeenAt
) {
}
