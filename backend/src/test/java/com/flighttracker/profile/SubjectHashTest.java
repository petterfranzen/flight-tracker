package com.flighttracker.profile;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The subject hash is the only thing that ever reaches the database from a
 * provider's identity (design §2), so it must be exactly
 * SHA-256(provider || ':' || subject) in lowercase hex — deterministic, and
 * with the provider folded in so two providers cannot collide.
 */
class SubjectHashTest {

    @Test
    void isLowercaseHexSha256OfProviderColonSubject() throws Exception {
        String hash = SubjectHash.of("google", "1234567890");

        byte[] expected = MessageDigest.getInstance("SHA-256")
                .digest("google:1234567890".getBytes(StandardCharsets.UTF_8));

        assertThat(hash).isEqualTo(HexFormat.of().formatHex(expected));
        assertThat(hash).hasSize(64).matches("[0-9a-f]{64}");
    }

    @Test
    void isDeterministic_forTheSameProviderAndSubject() {
        assertThat(SubjectHash.of("github", "abc"))
                .isEqualTo(SubjectHash.of("github", "abc"));
    }

    @Test
    void foldsTheProviderIn_soTheSameSubjectOnTwoProvidersDiffers() {
        assertThat(SubjectHash.of("google", "same-subject"))
                .isNotEqualTo(SubjectHash.of("github", "same-subject"));
    }

    @Test
    void changesWithTheSubject() {
        assertThat(SubjectHash.of("google", "subject-a"))
                .isNotEqualTo(SubjectHash.of("google", "subject-b"));
    }

    @Test
    void neverCarriesTheRawSubject() {
        String subject = "the-raw-provider-subject";
        assertThat(SubjectHash.of("google", subject)).doesNotContain(subject);
    }

    @Test
    void refusesMissingInputs_ratherThanHashingANull() {
        assertThatThrownBy(() -> SubjectHash.of(null, "x")).isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> SubjectHash.of("google", null)).isInstanceOf(NullPointerException.class);
    }
}
