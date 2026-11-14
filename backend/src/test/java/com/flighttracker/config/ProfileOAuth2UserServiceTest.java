package com.flighttracker.config;

import org.junit.jupiter.api.Test;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.oauth2.client.registration.ClientRegistration;
import org.springframework.security.oauth2.client.userinfo.OAuth2UserRequest;
import org.springframework.security.oauth2.client.userinfo.OAuth2UserService;
import org.springframework.security.oauth2.core.AuthorizationGrantType;
import org.springframework.security.oauth2.core.ClientAuthenticationMethod;
import org.springframework.security.oauth2.core.OAuth2AccessToken;
import org.springframework.security.oauth2.core.user.DefaultOAuth2User;
import org.springframework.security.oauth2.core.user.OAuth2User;
import org.springframework.security.oauth2.core.user.OAuth2UserAuthority;

import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Design section9-hq #84, §1.5: "no email or name ever arrives". GitHub keeps
 * returning a login, a name, an avatar and an email from {@code /user} even with
 * no scope, and the default user service keeps all of it in the session — in the
 * user's attributes <em>and</em> inside the {@link OAuth2UserAuthority} it adds
 * (step 3a), so the wrapper must strip both. This pins the wrapper's mapping
 * directly, with a delegate shaped like the real {@code DefaultOAuth2UserService}
 * output for GitHub.
 */
class ProfileOAuth2UserServiceTest {

    /** Exactly what GitHub's {@code /user} answers with at no scope. */
    private static final Map<String, Object> GITHUB_ATTRIBUTES = Map.of(
            "id", 42,
            "login", "octocat",
            "name", "The Octocat",
            "email", "octocat@example.com",
            "avatar_url", "https://avatars.example/octocat.png");

    @Test
    void keepsOnlyTheNumericAccountId() {
        // The default service's own authority set: one OAuth2UserAuthority holding the
        // full attribute map, plus the scope authorities.
        OAuth2UserService<OAuth2UserRequest, OAuth2User> githubUser = request ->
                new DefaultOAuth2User(
                        List.of(new OAuth2UserAuthority(GITHUB_ATTRIBUTES),
                                new SimpleGrantedAuthority("SCOPE_read:user")),
                        GITHUB_ATTRIBUTES,
                        "id");

        OAuth2User user = new OAuthClientConfig.IdOnlyOAuth2UserService(githubUser).loadUser(request());

        assertThat(user.getAttributes())
                .as("only the account id survives /user")
                .containsOnlyKeys("id");
        Object id = user.getAttribute("id");
        assertThat(id).isEqualTo(42);
        assertThat(user.getName()).isEqualTo("42");
        assertThat(user.getAuthorities()).extracting(GrantedAuthority::getAuthority)
                .containsExactly("OAUTH2_USER", "SCOPE_read:user");

        // The delegate's OAuth2UserAuthority still carries the whole GitHub attribute map;
        // mapping the authorities must leave none of them holding a field beyond the id, or
        // the login, name and email ride into the session inside the authority.
        List<OAuth2UserAuthority> attributeCarrying = user.getAuthorities().stream()
                .filter(OAuth2UserAuthority.class::isInstance)
                .map(OAuth2UserAuthority.class::cast)
                .toList();
        assertThat(attributeCarrying).as("the default service's one attribute-carrying authority").hasSize(1);
        assertThat(attributeCarrying.get(0).getAttributes())
                .as("no authority may carry anything but the account id")
                .containsOnlyKeys("id");
        assertThat(attributeCarrying.get(0).getAttributes().get("id")).isEqualTo(42);
    }

    private static OAuth2UserRequest request() {
        ClientRegistration github = ClientRegistration.withRegistrationId("github")
                .clientId("id")
                .clientSecret("secret")
                .clientAuthenticationMethod(ClientAuthenticationMethod.CLIENT_SECRET_BASIC)
                .authorizationGrantType(AuthorizationGrantType.AUTHORIZATION_CODE)
                .redirectUri("{baseUrl}/login/oauth2/code/{registrationId}")
                .authorizationUri("https://github.com/login/oauth/authorize")
                .tokenUri("https://github.com/login/oauth/access_token")
                .userInfoUri("https://api.github.com/user")
                .userNameAttributeName("id")
                .clientName("GitHub")
                .build();
        OAuth2AccessToken token = new OAuth2AccessToken(
                OAuth2AccessToken.TokenType.BEARER, "an-access-token",
                Instant.now(), Instant.now().plusSeconds(3600));
        return new OAuth2UserRequest(github, token);
    }
}
