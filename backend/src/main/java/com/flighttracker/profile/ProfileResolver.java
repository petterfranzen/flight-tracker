package com.flighttracker.profile;

import com.flighttracker.model.Profile;
import com.flighttracker.repository.ProfileRepository;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Service;

import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.Optional;

/**
 * Turns a completed social login (provider + subject) into a profile row.
 * Design section9-hq #84, step 5a-1: the login is where a profile comes into
 * existence, so this is the one place that creates one.
 *
 * <p>The raw subject never leaves this method: it is hashed by
 * {@link SubjectHash} and only the hash reaches the database (and, later, the
 * {@code (provider, subject_hash)} lookup). The row's {@code id} is 128 bits
 * from {@link SecureRandom}, base64url — opaque and never derived from the
 * subject, as {@code schema.sql} documents.
 *
 * <p>The first login for a subject inserts the row (both timestamps at now).
 * Every login after that returns the same row and only bumps
 * {@code last_seen_at} when a day has passed since it was last touched, so a
 * client that re-authenticates often does not write on every request. The
 * decision is made from the injected {@link Clock}, like every other timestamp
 * in the app, so a fixed Clock makes it deterministic in a test.
 *
 * <p>Flag-conditional, like {@code AuthController}: with
 * {@code flighttracker.profile.enabled=false} (the default) the bean does not
 * exist at all, so the flag-off app is unchanged.
 */
@Service
@ConditionalOnProperty(prefix = "flighttracker.profile", name = "enabled", havingValue = "true")
public class ProfileResolver {

    /** 128 bits of id, the width schema.sql's profile.id documents. */
    private static final int ID_BYTES = 16;

    /** How stale last_seen_at has to be before a login writes it again. */
    static final Duration TOUCH_AFTER = Duration.ofDays(1);

    private static final SecureRandom RANDOM = new SecureRandom();
    private static final Base64.Encoder ID_ENCODER = Base64.getUrlEncoder().withoutPadding();

    private final ProfileRepository profiles;
    private final SubjectHash subjectHash;
    private final Clock clock;

    public ProfileResolver(ProfileRepository profiles, SubjectHash subjectHash, Clock clock) {
        this.profiles = profiles;
        this.subjectHash = subjectHash;
        this.clock = clock;
    }

    /**
     * The profile for this login, creating it on first sight. A second login
     * for the same (provider, subject) returns the same id, and last_seen_at
     * moves at most once a day.
     */
    public Profile resolve(String provider, String subject) {
        String hash = subjectHash.of(provider, subject);
        Optional<Profile> created = profiles.insertIfAbsent(newId(), provider, hash);
        if (created.isPresent()) {
            return created.get();
        }
        Profile existing = profiles.findByProviderAndSubjectHash(provider, hash)
                .orElseThrow(() -> new IllegalStateException(
                        "profile for provider " + provider + " was gone right after its insert"));
        if (!isTouchDue(existing, clock.instant())) {
            return existing;
        }
        profiles.touch(existing.id());
        return profiles.findById(existing.id()).orElse(existing);
    }

    private static boolean isTouchDue(Profile profile, Instant now) {
        return !now.isBefore(profile.lastSeenAt().plus(TOUCH_AFTER));
    }

    private static String newId() {
        byte[] bytes = new byte[ID_BYTES];
        RANDOM.nextBytes(bytes);
        return ID_ENCODER.encodeToString(bytes);
    }
}
