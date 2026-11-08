package com.flighttracker.config;

import com.flighttracker.controller.ProfileController;
import com.flighttracker.profile.ProfileProperties;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.jdbc.autoconfigure.DataSourceAutoConfiguration;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Design section9-hq #84 step 2(b): drive a real login round-trip against a
 * local fake OIDC provider through the app's own chain, and prove the three
 * things the spike exists to settle — a session cookie appears, {@code GET
 * /api/profile} answers 200 once signed in, and the <b>session id changes</b>
 * at login (session-fixation protection, §5).
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

    @Test
    void aRealLoginIssuesASessionAnswersTheProfileAndChangesTheSessionId() throws Exception {
        HttpClient client = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build();

        // 1. The app starts the flow: a redirect to the provider, and a session is
        //    created to hold the authorization request (so there is an id to change).
        HttpResponse<Void> started = get(client, "http://127.0.0.1:" + PORT + "/oauth2/authorization/fake", null);
        assertThat(started.statusCode()).isEqualTo(302);
        String sessionBefore = sessionCookie(started).orElseThrow(() -> new AssertionError("no FT_SESSION before login"));
        String authorizeUrl = started.headers().firstValue("Location").orElseThrow();

        // 2. The provider authenticates and redirects back to the app's callback.
        HttpResponse<Void> fromProvider = get(client, authorizeUrl, null);
        assertThat(fromProvider.statusCode()).isEqualTo(302);
        String callback = fromProvider.headers().firstValue("Location").orElseThrow();
        assertThat(callback).contains("/login/oauth2/code/fake");

        // 3. The app exchanges the code and signs the visitor in.
        HttpResponse<Void> loggedIn = get(client, callback, sessionBefore);
        assertThat(loggedIn.statusCode()).isIn(200, 302);
        Optional<String> cookieAfter = sessionCookie(loggedIn);
        assertThat(cookieAfter).as("a session cookie after a successful login").isPresent();
        String sessionAfter = cookieAfter.orElseThrow();

        // The id must CHANGE at login: Spring's session-fixation protection.
        assertThat(sessionId(sessionAfter)).isNotEqualTo(sessionId(sessionBefore));
        assertThat(sessionAfter).contains("HttpOnly");

        // 4. The session reaches the profile, which reports the provider id only.
        HttpResponse<String> profile = getBody(client, "http://127.0.0.1:" + PORT + "/api/profile", sessionAfter);
        assertThat(profile.statusCode()).isEqualTo(200);
        assertThat(profile.body()).isEqualTo("{\"provider\":\"fake\"}");
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

    /** The FT_SESSION Set-Cookie (name, value and attributes), if one was set. */
    private static Optional<String> sessionCookie(HttpResponse<?> response) {
        return response.headers().allValues("Set-Cookie").stream()
                .filter(header -> header.startsWith("FT_SESSION="))
                .findFirst();
    }

    private static String sessionId(String setCookie) {
        return setCookie.substring("FT_SESSION=".length(), setCookie.indexOf(';'));
    }
}
