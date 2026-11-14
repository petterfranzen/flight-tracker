package com.flighttracker.config;

import org.springframework.boot.autoconfigure.condition.ConditionalOnExpression;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.oauth2.client.registration.ClientRegistration;
import org.springframework.security.oauth2.client.registration.ClientRegistrationRepository;
import org.springframework.security.oauth2.client.registration.InMemoryClientRegistrationRepository;
import org.springframework.security.oauth2.core.AuthorizationGrantType;
import org.springframework.security.oauth2.core.ClientAuthenticationMethod;

import java.util.ArrayList;
import java.util.List;

/**
 * The real Google and GitHub client registrations for optional social login
 * (design: section9-hq #84, step 3a). Only ever built with
 * {@code flighttracker.profile.enabled=true}.
 *
 * <p>These are declared here rather than under
 * {@code spring.security.oauth2.client.registration.*} on purpose. Boot validates
 * that a declared registration has a non-empty client id and refuses to start
 * otherwise, and an unset provider must be <em>absent</em>, not blank — so the
 * registration set is assembled from {@link OAuthClientProperties} and only the
 * providers that have a client id <b>and</b> a secret are added. With none
 * supplied there is no {@link ClientRegistrationRepository} bean at all, and
 * {@link ProfileSecurityConfig} therefore never installs {@code oauth2Login}:
 * the provider is off, not broken (design §4), exactly how Swedavia and
 * AeroDataBox behave today.
 *
 * <p>Both registrations ask for no personal data beyond the account id:
 *
 * <ul>
 *   <li><b>Google</b> is OIDC, so {@code scope=openid} alone. The id_token then
 *       carries only {@code sub/iss/aud/exp}, and because no user-info endpoint
 *       is configured Spring reads no further claim — no email, no name, no
 *       avatar ever reach this process (design §1.3).</li>
 *   <li><b>GitHub</b> is plain OAuth2 (it has no {@code openid} scope), so it
 *       requests <em>no</em> scope at all; {@code user:email} — the one scope
 *       that would deliver an address — is never asked for (design §1.5). The
 *       identifier is the numeric user id from {@code /user}.</li>
 * </ul>
 */
@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(prefix = "flighttracker.profile", name = "enabled", havingValue = "true")
@EnableConfigurationProperties(OAuthClientProperties.class)
public class OAuthClientConfig {

    static final String GOOGLE_REGISTRATION_ID = "google";

    static final String GITHUB_REGISTRATION_ID = "github";

    /**
     * Where the provider sends the browser back. Spring fills in the base URL and
     * the registration id, so the same value serves both providers.
     */
    static final String REDIRECT_URI = "{baseUrl}/login/oauth2/code/{registrationId}";

    /**
     * The registration set, present only when at least one provider has both a
     * client id and a secret. The expression mirrors
     * {@link OAuthClientProperties.Provider#configured()} so a provider with a
     * client id but no secret still leaves the repository (and {@code oauth2Login})
     * unbuilt.
     */
    @Bean
    @ConditionalOnExpression(
            "('${flighttracker.oauth.google.client-id:}' != '' && '${flighttracker.oauth.google.client-secret:}' != '')"
            + " || ('${flighttracker.oauth.github.client-id:}' != '' && '${flighttracker.oauth.github.client-secret:}' != '')")
    ClientRegistrationRepository clientRegistrationRepository(OAuthClientProperties properties) {
        List<ClientRegistration> registrations = new ArrayList<>();
        if (properties.getGoogle().configured()) {
            registrations.add(google(properties.getGoogle()));
        }
        if (properties.getGithub().configured()) {
            registrations.add(github(properties.getGithub()));
        }
        return new InMemoryClientRegistrationRepository(registrations);
    }

    private static ClientRegistration google(OAuthClientProperties.Provider provider) {
        return ClientRegistration.withRegistrationId(GOOGLE_REGISTRATION_ID)
                .clientId(provider.getClientId())
                .clientSecret(provider.getClientSecret())
                .clientAuthenticationMethod(ClientAuthenticationMethod.CLIENT_SECRET_BASIC)
                .authorizationGrantType(AuthorizationGrantType.AUTHORIZATION_CODE)
                .redirectUri(REDIRECT_URI)
                // openid alone: the only thing the id_token then carries is sub/iss/aud/exp.
                .scope("openid")
                .authorizationUri(provider.getAuthorizationUri())
                .tokenUri(provider.getTokenUri())
                .jwkSetUri(provider.getJwkSetUri())
                .issuerUri(provider.getIssuerUri())
                .userNameAttributeName("sub")
                .clientName("Google")
                // No userInfoUri on purpose: Spring reads the id_token and nothing else,
                // so no call is made that could return an email or a name.
                .build();
    }

    private static ClientRegistration github(OAuthClientProperties.Provider provider) {
        return ClientRegistration.withRegistrationId(GITHUB_REGISTRATION_ID)
                .clientId(provider.getClientId())
                .clientSecret(provider.getClientSecret())
                .clientAuthenticationMethod(ClientAuthenticationMethod.CLIENT_SECRET_BASIC)
                .authorizationGrantType(AuthorizationGrantType.AUTHORIZATION_CODE)
                .redirectUri(REDIRECT_URI)
                // No scope at all: openid is not a GitHub scope, and asking for nothing
                // keeps user:email (the one that delivers an address) off.
                .authorizationUri(provider.getAuthorizationUri())
                .tokenUri(provider.getTokenUri())
                .userInfoUri(provider.getUserInfoUri())
                .userNameAttributeName("id")
                .clientName("GitHub")
                .build();
    }
}
