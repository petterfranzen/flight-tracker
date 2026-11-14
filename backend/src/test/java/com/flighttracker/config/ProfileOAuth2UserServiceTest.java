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

import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Design section9-hq #84 step 3a, §1.5: "no email or name ever arrives". GitHub keeps
 * returning a login, a name, an avatar and an email from {@code /user} even with no scope,
 * and the default user service would keep all of it in the session. This pins the
 * wrapper's mapping directly, with a delegate standing in for GitHub's {@code /user}
 * response.
 */
class ProfileOAuth2UserServiceTest {

    @Test
    void keepsOnlyTheNumericAccountId() {
        OAuth2UserService<OAuth2UserRequest, OAuth2User> githubUser = request ->
                new DefaultOAuth2User(
                        List.of(new SimpleGrantedAuthority("ROLE_USER")),
                        Map.of(
                                "id", 42,
                                "login", "octocat",
                                "name", "The Octocat",
                                "email", "octocat@example.com",
                                "avatar_url", "https://avatars.example/octocat.png"),
                        "id");

        OAuth2User user = new OAuthClientConfig.IdOnlyOAuth2UserService(githubUser).loadUser(request());

        assertThat(user.getAttributes())
                .as("only the account id survives /user")
                .containsOnlyKeys("id");
        Object id = user.getAttribute("id");
        assertThat(id).isEqualTo(42);
        assertThat(user.getName()).isEqualTo("42");
        assertThat(user.getAuthorities()).extracting(GrantedAuthority::getAuthority).containsExactly("ROLE_USER");
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
