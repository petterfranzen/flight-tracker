package com.flighttracker.config;

import com.flighttracker.controller.ProfileController;
import com.flighttracker.profile.ProfileProperties;
import org.junit.jupiter.api.Test;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.jdbc.autoconfigure.DataSourceAutoConfiguration;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.security.oauth2.client.registration.ClientRegistration;
import org.springframework.security.oauth2.client.registration.ClientRegistrationRepository;
import org.springframework.security.oauth2.client.registration.InMemoryClientRegistrationRepository;
import org.springframework.security.oauth2.core.AuthorizationGrantType;
import org.springframework.security.oauth2.core.ClientAuthenticationMethod;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Design section9-hq #84 step 2(a): "add the chain and prove it locks nothing."
 *
 * <p>The first Spring Security chain in the app inverts the framework default
 * (deny-by-default): everything that exists today stays open and only
 * {@code /api/profile/**} needs a session. A wrong matcher silently locks the
 * map, {@code /ws/live} or the pollers, so this pins the open-and-permitted
 * behaviour of representative paths with the flag ON, plus the one thing that
 * must NOT be open (an anonymous profile read is a plain 401, never a redirect
 * to a login page).
 */
@SpringBootTest(
        classes = ProfileSecurityChainTest.MinimalApp.class,
        webEnvironment = SpringBootTest.WebEnvironment.DEFINED_PORT,
        properties = {
                "spring.main.banner-mode=off",
                "flighttracker.profile.enabled=true",
                "server.servlet.session.cookie.secure=false"
        })
class ProfileSecurityChainTest {

    private static final int PORT = freePort();

    private static int freePort() {
        try (ServerSocket socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        } catch (Exception ex) {
            throw new IllegalStateException("could not reserve a free port", ex);
        }
    }

    @SpringBootConfiguration
    @EnableAutoConfiguration(exclude = DataSourceAutoConfiguration.class)
    @EnableConfigurationProperties(ProfileProperties.class)
    @Import({ProfileSecurityConfig.class, ProfileController.class, SecurityHeadersFilter.class})
    static class MinimalApp {

        /**
         * A registration is all {@code oauth2Login} needs to be installed, and it must be
         * installed for the {@code /login} assertion below to mean anything: the generated
         * login page only exists once {@code oauth2Login} is configured. The real provider
         * registrations are pinned in {@link ProfileOAuthRegistrationsTest}; this one is a
         * stand-in so the chain is exercised in its flag-on, login-enabled shape.
         */
        @Bean
        ClientRegistrationRepository clientRegistrationRepository() {
            ClientRegistration google = ClientRegistration.withRegistrationId("google")
                    .clientId("test-client-id")
                    .clientSecret("test-client-secret")
                    .clientAuthenticationMethod(ClientAuthenticationMethod.CLIENT_SECRET_BASIC)
                    .authorizationGrantType(AuthorizationGrantType.AUTHORIZATION_CODE)
                    .redirectUri("https://flight.pastabake.cloud/login/oauth2/code/google")
                    .scope("openid")
                    .authorizationUri("https://accounts.google.com/o/oauth2/v2/auth")
                    .tokenUri("https://oauth2.googleapis.com/token")
                    .build();
            return new InMemoryClientRegistrationRepository(google);
        }

        /** Stand-ins for the real anonymous endpoints; only the paths matter here. */
        @RestController
        static class StubEndpoints {
            @GetMapping("/api/flights/live")
            String live() {
                return "live";
            }

            @GetMapping("/api/health")
            String health() {
                return "UP";
            }

            @PostMapping("/api/agents/restart")
            String restart() {
                return "restarted";
            }
        }
    }

    @DynamicPropertySource
    static void serverProperties(DynamicPropertyRegistry registry) {
        registry.add("server.port", () -> PORT);
        registry.add("server.address", () -> "127.0.0.1");
    }

    private static HttpResponse<String> send(String method, String path) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + PORT + path));
        if ("POST".equals(method)) {
            request.POST(HttpRequest.BodyPublishers.noBody());
        } else {
            request.GET();
        }
        return HttpClient.newHttpClient().send(request.build(), HttpResponse.BodyHandlers.ofString());
    }

    @Test
    void existingReadEndpointsStayOpen() throws Exception {
        // The map's own data endpoint...
        HttpResponse<String> live = send("GET", "/api/flights/live");
        assertThat(live.statusCode()).as("GET /api/flights/live must not be locked by the chain").isEqualTo(200);
        assertThat(live.body()).isEqualTo("live");

        // ...and the health probe deploy.sh waits on.
        assertThat(send("GET", "/api/health").statusCode()).isEqualTo(200);
    }

    @Test
    void theExistingAnonymousPostIsNotCsrf403() throws Exception {
        // POST /api/agents/restart works today and must keep working: CSRF is on,
        // but /api/agents/** is exempt (design §1.2).
        assertThat(send("POST", "/api/agents/restart").statusCode()).isEqualTo(200);
    }

    @Test
    void aProfileWriteWithoutATokenIsRejected() throws Exception {
        // CSRF is on for the profile write API, so a write with no token is a 403.
        assertThat(send("POST", "/api/profile").statusCode()).isEqualTo(403);
    }

    @Test
    void aPostOutsideTheProfileApiKeepsIts405NotA403() throws Exception {
        // blackbox-tests/error-bodies.test.js: POST /api/health is 405 (method not allowed).
        // A blanket CSRF config silently flips it to 403; this pins the scoped one.
        assertThat(send("POST", "/api/health").statusCode()).isEqualTo(405);
    }

    @Test
    void anAnonymousProfileReadIsAPlain401NotARedirect() throws Exception {
        HttpResponse<String> response = send("GET", "/api/profile");
        assertThat(response.statusCode()).isEqualTo(401);
        assertThat(response.headers().firstValue("Location")).isEmpty();
        assertThat(response.headers().firstValue("WWW-Authenticate")).isEmpty();
    }

    @Test
    void malformedPathsAreRejectedByTheStrictFirewallWithTheFlagOn() throws Exception {
        // With the flag on the chain keeps Spring Security's default StrictHttpFirewall, which
        // rejects these outright. The flag-off path deliberately does not (it uses
        // DefaultHttpFirewall so production stays byte-identical) — see
        // ProfileSecurityFlagOffTest.malformedPathsBehaveAsBeforeTheChain_andStillCarryTheAppHeaders.
        assertThat(send("GET", "//api/health").statusCode()).isEqualTo(400);
        assertThat(send("GET", "/api/health;x=1").statusCode()).isEqualTo(400);
    }

    @Test
    void anAnonymousVisitSetsNoSessionCookie() throws Exception {
        // IF_REQUIRED: nothing asks for a session on a map-only visit, so no cookie.
        assertThat(send("GET", "/api/flights/live").headers().allValues("Set-Cookie"))
                .as("an anonymous read must not create a session")
                .noneMatch(cookie -> cookie.startsWith("FT_SESSION="));
    }

    @Test
    void theFlagOnChainCarriesExactlyOneSetOfTheAppsHeaders() throws Exception {
        // The app's own SecurityHeadersFilter is the one owner of the response headers.
        // Spring Security's HeaderWriterFilter, left enabled, adds its own defaults on top
        // of them (Cache-Control/Pragma/Expires, X-XSS-Protection, a second X-Frame-Options),
        // so this pins that each app header appears exactly once and none of Spring's do.
        var headers = send("GET", "/api/flights/live").headers();

        assertThat(headers.allValues("Content-Security-Policy")).hasSize(1);
        assertThat(headers.allValues("Content-Security-Policy").get(0)).contains(
                "frame-ancestors 'none'", "script-src 'self'",
                "connect-src 'self' https://tiles.openfreemap.org",
                "default-src 'self'");
        assertThat(headers.allValues("X-Content-Type-Options")).containsExactly("nosniff");
        assertThat(headers.allValues("X-Frame-Options")).containsExactly("DENY");
        assertThat(headers.allValues("Referrer-Policy")).containsExactly("strict-origin-when-cross-origin");
        assertThat(headers.allValues("Permissions-Policy")).hasSize(1);

        // Spring Security's own header set must be absent entirely.
        assertThat(headers.allValues("Cache-Control")).as("Spring's Cache-Control").isEmpty();
        assertThat(headers.allValues("Pragma")).as("Spring's Pragma").isEmpty();
        assertThat(headers.allValues("X-XSS-Protection")).as("Spring's X-XSS-Protection").isEmpty();
    }

    @Test
    void thereIsNoGeneratedLoginPage() throws Exception {
        // No server-rendered login page: the chain names the login page as the SPA root, and
        // Spring's default login page generator must not answer /login (measured: this
        // oauth2Login-only chain in Security 7.1 carries no DefaultLoginPageGeneratingFilter,
        // so the explicit page is belt-and-braces against a framework or config change).
        // /login therefore has no server-side handler at all: a 404 here, or a redirect to SPA.
        HttpResponse<String> response = send("GET", "/login");
        assertThat(response.statusCode())
                .as("GET /login must not serve a generated page")
                .isIn(301, 302, 303, 307, 308, 404);
        assertThat(response.body()).doesNotContain("<form", "Sign in");
        response.headers().firstValue("Location").ifPresent(location -> assertThat(location).isEqualTo("/"));
    }

    @Test
    void theCsrfMatcherIsTheAuthorizeMatcherPlusSignOut() {
        // One source of truth: the CSRF rule guards writes on exactly the paths the authorize
        // rule protects, plus the sign-out POST — and nothing else.
        assertThat(ProfileSecurityConfig.CSRF_PROTECTED_PATHS)
                .containsAll(ProfileSecurityConfig.AUTHENTICATED_PATHS)
                .contains(ProfileSecurityConfig.LOGOUT_PATH)
                .hasSize(ProfileSecurityConfig.AUTHENTICATED_PATHS.size() + 1);

        assertThat(csrfProtects("POST", "/api/profile")).as("the profile write API").isTrue();
        assertThat(csrfProtects("POST", "/api/profile/favorites")).as("under the API").isTrue();
        assertThat(csrfProtects("POST", "/api/auth/logout")).as("sign-out").isTrue();
        // The old matcher was startsWith("/api/profile"), which token-checked this too.
        assertThat(csrfProtects("POST", "/api/profileX")).as("outside the API pattern").isFalse();
        assertThat(csrfProtects("GET", "/api/profile")).as("a safe read is never token-checked").isFalse();
        assertThat(csrfProtects("POST", "/api/health")).as("POST /api/health keeps its 405").isFalse();
        assertThat(csrfProtects("POST", "/api/agents/restart")).as("the existing anonymous POST").isFalse();
    }

    private static boolean csrfProtects(String method, String uri) {
        return ProfileSecurityConfig.isCsrfProtectedWrite(new MockHttpServletRequest(method, uri));
    }

    @Test
    void aWriteOutsideTheAuthorizePatternIsNotCsrf403() throws Exception {
        // Behavioural twin of the matcher check above: before the fix this path matched the
        // string prefix and was a 403; now CSRF does not touch it and it falls through to MVC.
        assertThat(send("POST", "/api/profileX").statusCode()).isNotEqualTo(403);
    }
}
