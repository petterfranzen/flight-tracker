package com.flighttracker.profile;

import org.junit.jupiter.api.Test;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.util.HexFormat;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The subject hash is the only thing that ever reaches the database from a
 * provider's identity (design §2), so it must be exactly
 * HMAC-SHA256(pepper, provider || ':' || subject) in lowercase hex — <b>keyed</b>
 * (finding M2, section9-hq #405: a plain SHA-256 over GitHub's small sequential
 * ids is a dictionary lookup), deterministic, and with the provider folded in so
 * two providers cannot collide.
 */
class SubjectHashTest {

    private static final String PEPPER = "unit-test-pepper";
    private final SubjectHash subjectHash = new SubjectHash(PEPPER);

    @Test
    void isLowercaseHexHmacSha256OfThePepperOverProviderColonSubject() throws Exception {
        String hash = subjectHash.of("google", "1234567890");

        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(PEPPER.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        byte[] expected = mac.doFinal("google:1234567890".getBytes(StandardCharsets.UTF_8));

        assertThat(hash).isEqualTo(HexFormat.of().formatHex(expected));
        assertThat(hash).hasSize(64).matches("[0-9a-f]{64}");
    }

    @Test
    void thePepperIsTheKey_soTheSameSubjectUnderTwoPeppersDiffers() {
        assertThat(subjectHash.of("github", "4242"))
                .isNotEqualTo(new SubjectHash("another-pepper").of("github", "4242"));
    }

    @Test
    void isDeterministic_forTheSameProviderAndSubject() {
        assertThat(subjectHash.of("github", "abc")).isEqualTo(subjectHash.of("github", "abc"));
    }

    @Test
    void foldsTheProviderIn_soTheSameSubjectOnTwoProvidersDiffers() {
        assertThat(subjectHash.of("google", "same-subject"))
                .isNotEqualTo(subjectHash.of("github", "same-subject"));
    }

    @Test
    void changesWithTheSubject() {
        assertThat(subjectHash.of("google", "subject-a"))
                .isNotEqualTo(subjectHash.of("google", "subject-b"));
    }

    @Test
    void neverCarriesTheRawSubject() {
        String subject = "the-raw-provider-subject";
        assertThat(subjectHash.of("google", subject)).doesNotContain(subject);
    }

    @Test
    void refusesMissingInputs_ratherThanHashingANull() {
        assertThatThrownBy(() -> subjectHash.of(null, "x")).isInstanceOf(NullPointerException.class);
        assertThatThrownBy(() -> subjectHash.of("google", null)).isInstanceOf(NullPointerException.class);
    }

    @Test
    void refusesABlankPepper_ratherThanHashingWithoutAKey() {
        assertThatThrownBy(() -> new SubjectHash(null)).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> new SubjectHash("")).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> new SubjectHash("   ")).isInstanceOf(IllegalStateException.class);
    }
}
