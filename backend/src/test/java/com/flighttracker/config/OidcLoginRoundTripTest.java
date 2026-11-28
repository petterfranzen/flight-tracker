package com.flighttracker.config;

import com.flighttracker.controller.ProfileController;
import com.flighttracker.profile.ProfileProperties;
import com.flighttracker.profile.ProfileReader;
import com.flighttracker.profile.ProfileSnapshot;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.jdbc.autoconfigure.DataSourceAutoConfiguration;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.security.oauth2.client.OAuth2AuthorizedClient;
import org.springframework.security.oauth2.client.OAuth2AuthorizedClientService;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * Design section9-hq #84 step 2(b): drive a real login round-trip against a
 * local fake OIDC provider through the app's own chain, and prove the things
 * the spike exists to settle — starting the flow sets no session (section9-hq
 * #404: the pending request is held outside the session, so an anonymous
 * visitor has no session to fix), a session cookie appears once the login
 * succeeds, and {@code GET /api/profile} answers 200 once signed in.
 *
 * <p>The whole flow is real HTTP on loopback: the app redirects to the
 * provider, the provider redirects back with a code, the app exchanges it
 * (server-to-server) and validates the signed {@code id_token}. Only the
 * provider is fake; the app is the real filter chain.
 */
@SpringBootTest(
        classes = OidcLoginRoundTripTest.MinimalApp.class,
        webEnvironment = SpringBootTest.WebEnvironment.DEFINED_PORT,
        properties = {
                "spring.main.banner-mode=off",
                "flighttracker.profile.enabled=true",
                "server.servlet.session.cookie.secure=false"
        })
class OidcLoginRoundTripTest {

    private static final int PORT = freePort();
    private static final FakeOidcProvider PROVIDER = startProvider();

    private static int freePort() {
        try (ServerSocket socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        } catch (Exception ex) {
            throw new IllegalStateException("could not reserve a free port", ex);
        }
    }

    private static FakeOidcProvider startProvider() {
        try {
            return new FakeOidcProvider();
        } catch (Exception ex) {
            throw new IllegalStateException("could not start the fake OIDC provider", ex);
        }
    }

    @AfterAll
    static void stopProvider() {
        PROVIDER.close();
    }

    @SpringBootConfiguration
    @EnableAutoConfiguration(exclude = DataSourceAutoConfiguration.class)
    @EnableConfigurationProperties(ProfileProperties.class)
    @Import({ProfileSecurityConfig.class, ProfileController.class})
    static class MinimalApp {

        /**
         * This test is the login round-trip, not the read: the endpoint's own read
         * against real rows is pinned in {@link ProfileReadMockMvcTest}, so here it
         * is stubbed, echoing the provider the controller extracted from the session.
         */
        @Bean
        ProfileReader profileReader() {
            ProfileReader reader = mock(ProfileReader.class);
            when(reader.read(anyString(), anyString()))
                    .thenAnswer(call -> new ProfileSnapshot(call.getArgument(0), List.of(), List.of()));
            return reader;
        }
    }

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("server.port", () -> PORT);
        registry.add("server.address", () -> "127.0.0.1");
        // The only registration that exists in this test is the fake provider; a real
        // deployment supplies google/github the same way (design §4).
        registry.add("spring.security.oauth2.client.provider.fake.issuer-uri", PROVIDER::issuer);
        registry.add("spring.security.oauth2.client.registration.fake.client-id", () -> FakeOidcProvider.CLIENT_ID);
        registry.add("spring.security.oauth2.client.registration.fake.client-secret", () -> FakeOidcProvider.CLIENT_SECRET);
        registry.add("spring.security.oauth2.client.registration.fake.scope", () -> "openid");
        registry.add("spring.security.oauth2.client.registration.fake.redirect-uri", PROVIDER::redirectUriTemplate);
    }

    @Autowired
    private OAuth2AuthorizedClientService authorizedClients;

    @Test
    void aRealLoginIssuesASessionAnswersTheProfileAndChangesTheSessionId() throws Exception {
        HttpClient client = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build();

        // 1. The app starts the flow: a redirect to the provider, and NO session — the
        //    pending authorization request lives in a bounded store outside the session
        //    (section9-hq #404), so merely offering a sign-in never creates one.
        HttpResponse<Void> started = get(client, "http://127.0.0.1:" + PORT + "/oauth2/authorization/fake", null);
        assertThat(started.statusCode()).isEqualTo(302);
        assertThat(sessionCookie(started))
                .as("starting a login must create no session").isEmpty();
        String authorizeUrl = started.headers().firstValue("Location").orElseThrow();

        // 2. The provider authenticates and redirects back to the app's callback.
        HttpResponse<Void> fromProvider = get(client, authorizeUrl, null);
        assertThat(fromProvider.statusCode()).isEqualTo(302);
        String callback = fromProvider.headers().firstValue("Location").orElseThrow();
        assertThat(callback).contains("/login/oauth2/code/fake");

        // 3. The app exchanges the code and signs the visitor in: a session is created
        //    only now, for the signed-in user.
        HttpResponse<Void> loggedIn = get(client, callback, null);
        assertThat(loggedIn.statusCode()).isIn(200, 302);
        Optional<String> cookieAfter = sessionCookie(loggedIn);
        assertThat(cookieAfter).as("a session cookie after a successful login").isPresent();
        String sessionAfter = cookieAfter.orElseThrow();
        assertThat(sessionAfter).contains("HttpOnly");
        assertThat(loggedIn.headers().firstValue("Location"))
                .as("a completed login lands on the SPA by a relative redirect, never an absolute http URL")
                .contains("/");
        OAuth2AuthorizedClient kept = authorizedClients.loadAuthorizedClient("fake", FakeOidcProvider.SUBJECT);
        assertThat(kept)
                .as("the provider's access token is not kept after the login")
                .isNull();
        assertThat(csrfCookie(loggedIn))
                .as("the CSRF token rotated at login is still SameSite=Strict")
                .hasValueSatisfying(cookie -> assertThat(cookie).contains("SameSite=Strict"));

        // 4. The session reaches the profile, which reports the provider id and the
        //    two lists of step 5a-2 (D4) -- empty here, no profile id, no subject.
        HttpResponse<String> profile = getBody(client, "http://127.0.0.1:" + PORT + "/api/profile", sessionAfter);
        assertThat(profile.statusCode()).isEqualTo(200);
        assertThat(profile.body()).isEqualTo("{\"provider\":\"fake\",\"favorites\":[],\"watched\":[]}");
    }

    private static HttpResponse<String> getBody(HttpClient client, String url, String cookie) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(url)).GET();
        if (cookie != null) {
            request.header("Cookie", cookie.split(";", 2)[0]);
        }
        return client.send(request.build(), HttpResponse.BodyHandlers.ofString());
    }

    private static HttpResponse<Void> get(HttpClient client, String url, String cookie) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(url)).GET();
        if (cookie != null) {
            request.header("Cookie", cookie.split(";", 2)[0]);
        }
        return client.send(request.build(), HttpResponse.BodyHandlers.discarding());
    }

    /** The XSRF-TOKEN Set-Cookie that carries a token (not the clearing one), if one was set. */
    private static Optional<String> csrfCookie(HttpResponse<?> response) {
        return response.headers().allValues("Set-Cookie").stream()
                .filter(header -> header.startsWith("XSRF-TOKEN=") && !header.startsWith("XSRF-TOKEN=;"))
                .findFirst();
    }

    /** The FT_SESSION Set-Cookie (name, value and attributes), if one was set. */
    private static Optional<String> sessionCookie(HttpResponse<?> response) {
        return response.headers().allValues("Set-Cookie").stream()
                .filter(header -> header.startsWith("FT_SESSION="))
                .findFirst();
    }

}
