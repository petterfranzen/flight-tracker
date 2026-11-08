package com.flighttracker.config;

import com.flighttracker.controller.ProfileController;
import com.flighttracker.profile.ProfileProperties;
import org.junit.jupiter.api.Test;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.jdbc.autoconfigure.DataSourceAutoConfiguration;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
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
 * Design section9-hq #84 step 2, the production default: with
 * {@code flighttracker.profile.enabled=false} the app is unchanged for an
 * anonymous visitor — no security redirect, no CSRF 403, no session cookie —
 * and the profile endpoint answers {@code 503} so the SPA can hide the
 * sign-in control instead of showing a broken one (§7).
 */
@SpringBootTest(
        classes = ProfileSecurityFlagOffTest.MinimalApp.class,
        webEnvironment = SpringBootTest.WebEnvironment.DEFINED_PORT,
        properties = {
                "spring.main.banner-mode=off",
                "flighttracker.profile.enabled=false"
        })
class ProfileSecurityFlagOffTest {

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
    @Import({ProfileSecurityConfig.class, ProfileController.class})
    static class MinimalApp {

        @RestController
        static class StubEndpoints {
            @GetMapping("/api/flights/live")
            String live() {
                return "live";
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
    void theProfileEndpointAnswers503WhenTheFlagIsOff() throws Exception {
        assertThat(send("GET", "/api/profile").statusCode()).isEqualTo(503);
    }

    @Test
    void anonymousTrafficIsUnchangedWithTheChainOff() throws Exception {
        assertThat(send("GET", "/api/flights/live").statusCode()).isEqualTo(200);
        // Nothing about the off path changes CSRF: the existing POST is not 403.
        assertThat(send("POST", "/api/agents/restart").statusCode()).isEqualTo(200);
    }

    @Test
    void noSessionCookieIsEverSetOnTheOffPath() throws Exception {
        assertThat(send("GET", "/api/flights/live").headers().allValues("Set-Cookie")).isEmpty();
        assertThat(send("GET", "/api/profile").headers().allValues("Set-Cookie")).isEmpty();
    }
}
