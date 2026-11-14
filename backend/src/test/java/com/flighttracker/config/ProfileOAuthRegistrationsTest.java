package com.flighttracker.config;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.ConfigDataApplicationContextInitializer;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.security.oauth2.client.registration.ClientRegistration;
import org.springframework.security.oauth2.client.registration.ClientRegistrationRepository;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Design section9-hq #84 step 3a: "Google and GitHub registrations from env, a
 * provider with no secret is off."
 *
 * <p>The registration set is assembled in {@link OAuthClientConfig} rather than
 * declared in {@code application.yml}, because Boot refuses to start on a
 * <em>blank</em> client id — an unset provider has to be absent, not empty. These
 * cases pin the three states that matter: no provider at all (no repository, so
 * {@code oauth2Login} is never installed), only the provider whose id and secret
 * are both supplied, and the scope each registration asks for — {@code openid}
 * alone on Google, nothing at all on GitHub (design §1.3/§1.5, "no email or name
 * ever arrives").
 */
class ProfileOAuthRegistrationsTest {

    /**
     * Loads the real {@code application.yml}, so the endpoint and scope defaults each
     * registration is built with are the ones the app actually ships — the test does
     * not restate them.
     */
    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withInitializer(new ConfigDataApplicationContextInitializer())
            .withUserConfiguration(OAuthClientConfig.class)
            .withPropertyValues("flighttracker.profile.enabled=true");

    @Test
    void noProviderIsRegisteredWhenNoSecretIsSupplied() {
        runner.withPropertyValues(
                        // Hermetic: do not let a credential in the environment register one.
                        "flighttracker.oauth.google.client-id=",
                        "flighttracker.oauth.google.client-secret=",
                        "flighttracker.oauth.github.client-id=",
                        "flighttracker.oauth.github.client-secret=")
                .run(context -> assertThat(context)
                .as("no client id and secret means no repository bean, so no oauth2Login")
                .doesNotHaveBean(ClientRegistrationRepository.class));
    }

    @Test
    void aProviderWithAClientIdButNoSecretStaysOff() {
        runner.withPropertyValues(
                        "flighttracker.oauth.google.client-id=an-id",
                        "flighttracker.oauth.google.client-secret=")
                .run(context -> assertThat(context)
                        .as("an id without a secret is not a credential")
                        .doesNotHaveBean(ClientRegistrationRepository.class));
    }

    @Test
    void onlyTheProviderWithBothHalvesIsRegistered() {
        // Google is fully supplied, GitHub has a client id but no secret: the
        // registration set exists (Google), and the partial provider is still left out.
        runner.withPropertyValues(
                        "flighttracker.oauth.google.client-id=google-id",
                        "flighttracker.oauth.google.client-secret=google-secret",
                        "flighttracker.oauth.github.client-id=github-id",
                        "flighttracker.oauth.github.client-secret=")
                .run(context -> {
                    ClientRegistrationRepository registrations =
                            context.getBean(ClientRegistrationRepository.class);
                    assertThat(registrations.findByRegistrationId("google")).isNotNull();
                    assertThat(registrations.findByRegistrationId("github"))
                            .as("a client id without a secret is not a credential; the provider stays off")
                            .isNull();
                });
    }

    @Test
    void googleAsksForTheOpenidScopeOnlyAndReadsNoUserInfo() {
        runner.withPropertyValues(
                        "flighttracker.oauth.google.client-id=google-id",
                        "flighttracker.oauth.google.client-secret=google-secret")
                .run(context -> {
                    ClientRegistration google = context.getBean(ClientRegistrationRepository.class)
                            .findByRegistrationId("google");
                    assertThat(google.getScopes())
                            .as("openid alone: the id_token carries only sub/iss/aud/exp")
                            .containsExactly("openid");
                    assertThat(google.getProviderDetails().getUserInfoEndpoint().getUri())
                            .as("no user-info endpoint: nothing can return an email or a name")
                            .isNull();
                    assertThat(google.getProviderDetails().getUserInfoEndpoint().getUserNameAttributeName())
                            .isEqualTo("sub");
                    assertThat(google.getProviderDetails().getIssuerUri())
                            .isEqualTo("https://accounts.google.com");
                });
    }

    @Test
    void githubAsksForNoScopeAndUsesTheNumericUserId() {
        runner.withPropertyValues(
                        "flighttracker.oauth.github.client-id=github-id",
                        "flighttracker.oauth.github.client-secret=github-secret")
                .run(context -> {
                    ClientRegistration github = context.getBean(ClientRegistrationRepository.class)
                            .findByRegistrationId("github");
                    assertThat(github.getScopes())
                            .as("GitHub is plain OAuth2; user:email is never asked for")
                            .isEmpty();
                    assertThat(github.getProviderDetails().getUserInfoEndpoint().getUserNameAttributeName())
                            .isEqualTo("id");
                });
    }

    @Test
    void theEndpointsAreOverridableSoTheBlackboxFakeProviderCanBePointedAt() {
        runner.withPropertyValues(
                        "flighttracker.oauth.google.client-id=google-id",
                        "flighttracker.oauth.google.client-secret=google-secret",
                        "flighttracker.oauth.google.authorization-uri=http://localhost:9/authorize",
                        "flighttracker.oauth.google.token-uri=http://localhost:9/token",
                        "flighttracker.oauth.google.jwk-set-uri=http://localhost:9/jwks",
                        "flighttracker.oauth.google.issuer-uri=http://localhost:9")
                .run(context -> {
                    ClientRegistration google = context.getBean(ClientRegistrationRepository.class)
                            .findByRegistrationId("google");
                    var provider = google.getProviderDetails();
                    assertThat(provider.getAuthorizationUri()).isEqualTo("http://localhost:9/authorize");
                    assertThat(provider.getTokenUri()).isEqualTo("http://localhost:9/token");
                    assertThat(provider.getJwkSetUri()).isEqualTo("http://localhost:9/jwks");
                    assertThat(provider.getIssuerUri()).isEqualTo("http://localhost:9");
                });
    }
}
