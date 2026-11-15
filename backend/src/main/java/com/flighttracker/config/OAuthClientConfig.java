package com.flighttracker.config;

import com.flighttracker.profile.ProfileProperties;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Conditional;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.oauth2.client.registration.ClientRegistration;
import org.springframework.security.oauth2.client.registration.ClientRegistrationRepository;
import org.springframework.security.oauth2.client.registration.InMemoryClientRegistrationRepository;
import org.springframework.security.oauth2.client.userinfo.DefaultOAuth2UserService;
import org.springframework.security.oauth2.client.userinfo.OAuth2UserRequest;
import org.springframework.security.oauth2.client.userinfo.OAuth2UserService;
import org.springframework.security.oauth2.core.AuthorizationGrantType;
import org.springframework.security.oauth2.core.ClientAuthenticationMethod;
import org.springframework.security.oauth2.core.OAuth2AuthenticationException;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.oauth2.core.user.DefaultOAuth2User;
import org.springframework.security.oauth2.core.user.OAuth2User;
import org.springframework.security.oauth2.core.user.OAuth2UserAuthority;

import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

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
 * AeroDataBox behave today. {@link OAuthClientConfiguredCondition} gates the bean
 * on the same predicate the assembly uses, so a whitespace-only credential leaves
 * the provider off rather than building an empty repository.
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
 *       that would deliver an address — is never asked for (design §1.5). GitHub's
 *       {@code /user} still returns login, name, avatar and email at no scope, so
 *       {@link IdOnlyOAuth2UserService} keeps only the numeric user id and drops
 *       everything else before it reaches the session.</li>
 * </ul>
 */
@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(prefix = "flighttracker.profile", name = "enabled", havingValue = "true")
@EnableConfigurationProperties({OAuthClientProperties.class, ProfileProperties.class})
public class OAuthClientConfig {

    static final String GOOGLE_REGISTRATION_ID = "google";

    static final String GITHUB_REGISTRATION_ID = "github";

    /**
     * Spring's own placeholder template, used only when no public base URL is
     * configured (local development behind no proxy). Behind Cloudflare this value
     * is wrong: TLS terminates at the edge and the app sees plain http, so
     * {@code {baseUrl}} would resolve to {@code http://...} and the provider would
     * reject the callback.
     */
    static final String PLACEHOLDER_REDIRECT_URI = "{baseUrl}/login/oauth2/code/{registrationId}";

    /**
     * Where the provider sends the browser back. Built from the configured public
     * base URL so the callback is https even though the app itself is reached over
     * http behind Cloudflare; falls back to Spring's placeholder when unset.
     */
    static String redirectUri(String publicBaseUrl, String registrationId) {
        if (!publicBaseUrl.isBlank()) {
            String base = publicBaseUrl.endsWith("/")
                    ? publicBaseUrl.substring(0, publicBaseUrl.length() - 1)
                    : publicBaseUrl;
            return base + "/login/oauth2/code/" + registrationId;
        }
        return PLACEHOLDER_REDIRECT_URI;
    }

    /**
     * The registration set, present only when at least one provider has both a
     * client id and a secret. The condition mirrors
     * {@link OAuthClientProperties.Provider#configured()} so a provider with a
     * client id but no secret still leaves the repository (and {@code oauth2Login})
     * unbuilt.
     */
    @Bean
    @Conditional(OAuthClientConfiguredCondition.class)
    ClientRegistrationRepository clientRegistrationRepository(
            OAuthClientProperties properties, ProfileProperties profile) {
        String baseUrl = profile.publicBaseUrl();
        List<ClientRegistration> registrations = new ArrayList<>();
        if (properties.getGoogle().configured()) {
            registrations.add(google(properties.getGoogle(), baseUrl));
        }
        if (properties.getGithub().configured()) {
            registrations.add(github(properties.getGithub(), baseUrl));
        }
        return new InMemoryClientRegistrationRepository(registrations);
    }

    /**
     * The user service the plain-OAuth2 login path runs (design §1.5). GitHub's
     * {@code /user} answers with login, name, avatar and email even when no scope is
     * requested, and the default service would keep all of it in the session's
     * {@link OAuth2User}. This wrapper keeps the numeric account id and nothing else,
     * so "no email or name ever arrives" holds for GitHub too. It only ever runs for
     * a non-OIDC provider (Google loads its user from the id_token), and it is only
     * declared with the flag on.
     */
    @Bean
    OAuth2UserService<OAuth2UserRequest, OAuth2User> idOnlyOAuth2UserService() {
        return new IdOnlyOAuth2UserService(new DefaultOAuth2UserService());
    }

    private static ClientRegistration google(OAuthClientProperties.Provider provider, String baseUrl) {
        return ClientRegistration.withRegistrationId(GOOGLE_REGISTRATION_ID)
                .clientId(provider.getClientId())
                .clientSecret(provider.getClientSecret())
                .clientAuthenticationMethod(ClientAuthenticationMethod.CLIENT_SECRET_BASIC)
                .authorizationGrantType(AuthorizationGrantType.AUTHORIZATION_CODE)
                .redirectUri(redirectUri(baseUrl, GOOGLE_REGISTRATION_ID))
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

    private static ClientRegistration github(OAuthClientProperties.Provider provider, String baseUrl) {
        return ClientRegistration.withRegistrationId(GITHUB_REGISTRATION_ID)
                .clientId(provider.getClientId())
                .clientSecret(provider.getClientSecret())
                .clientAuthenticationMethod(ClientAuthenticationMethod.CLIENT_SECRET_BASIC)
                .authorizationGrantType(AuthorizationGrantType.AUTHORIZATION_CODE)
                .redirectUri(redirectUri(baseUrl, GITHUB_REGISTRATION_ID))
                // No scope at all: openid is not a GitHub scope, and asking for nothing
                // keeps user:email (the one that delivers an address) off.
                .authorizationUri(provider.getAuthorizationUri())
                .tokenUri(provider.getTokenUri())
                .userInfoUri(provider.getUserInfoUri())
                .userNameAttributeName("id")
                .clientName("GitHub")
                .build();
    }

    /**
     * Keeps only the account id of a plain-OAuth2 provider's user. GitHub's
     * {@code /user} returns login, name, avatar and email even at no scope; the
     * default service keeps every attribute in the session, which contradicts
     * "no email or name ever arrives". Delegating to the default and then rebuilding
     * the user with a one-entry attribute map drops the rest.
     */
    static final class IdOnlyOAuth2UserService implements OAuth2UserService<OAuth2UserRequest, OAuth2User> {

        private final OAuth2UserService<OAuth2UserRequest, OAuth2User> delegate;

        IdOnlyOAuth2UserService(OAuth2UserService<OAuth2UserRequest, OAuth2User> delegate) {
            this.delegate = delegate;
        }

        @Override
        public OAuth2User loadUser(OAuth2UserRequest userRequest) throws OAuth2AuthenticationException {
            OAuth2User user = delegate.loadUser(userRequest);
            String idKey = userRequest.getClientRegistration()
                    .getProviderDetails().getUserInfoEndpoint().getUserNameAttributeName();
            Map<String, Object> idOnly = new HashMap<>();
            idOnly.put(idKey, user.getAttribute(idKey));
            return new DefaultOAuth2User(idOnlyAuthorities(user.getAuthorities(), idOnly), idOnly, idKey);
        }

        /**
         * Rebuilds the delegate's authorities so none of them carries the provider's
         * raw attribute map. {@code DefaultOAuth2UserService} adds an
         * {@link OAuth2UserAuthority} holding the <em>full</em> GitHub attribute map
         * (login, name, email), so keeping only the id in the user's own attributes is
         * not enough on its own — the same values would still ride in the session
         * inside that authority. Every {@code OAuth2UserAuthority} is rebuilt around
         * the id-only map; anything else (the scope authorities) is passed through.
         */
        private static Set<GrantedAuthority> idOnlyAuthorities(
                Collection<? extends GrantedAuthority> authorities, Map<String, Object> idOnly) {
            Set<GrantedAuthority> mapped = new LinkedHashSet<>();
            for (GrantedAuthority authority : authorities) {
                mapped.add(authority instanceof OAuth2UserAuthority
                        ? new OAuth2UserAuthority(idOnly)
                        : authority);
            }
            return mapped;
        }
    }
}
