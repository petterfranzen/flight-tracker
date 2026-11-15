package com.flighttracker.config;

import com.flighttracker.controller.AuthController;
import com.flighttracker.controller.ProfileController;
import com.flighttracker.profile.ProfileProperties;
import jakarta.servlet.http.Cookie;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.jdbc.autoconfigure.DataSourceAutoConfiguration;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * Design section9-hq #84, step 3b-1: {@code POST /api/auth/logout}. Local sign-out
 * only — the session is invalidated and the {@code FT_SESSION} cookie cleared, so
 * the next request is anonymous. It sits under the same scoped CSRF rule as the
 * profile writes (a token is required), and it must not widen that rule: no other
 * anonymous POST changes behaviour (pinned in {@link ProfileSecurityChainTest}).
 *
 * <p>The token is obtained the way the SPA does it: a first request issues the
 * readable {@code XSRF-TOKEN} cookie (the {@code .spa()} handler), and the POST
 * echoes it back in the {@code X-XSRF-TOKEN} header.
 */
@SpringBootTest(
        classes = ProfileLogoutTest.MinimalApp.class,
        properties = {
                "spring.main.banner-mode=off",
                "flighttracker.profile.enabled=true",
                "server.servlet.session.cookie.secure=false"
        })
@AutoConfigureMockMvc
class ProfileLogoutTest {

    @SpringBootConfiguration
    @EnableAutoConfiguration(exclude = DataSourceAutoConfiguration.class)
    @EnableConfigurationProperties(ProfileProperties.class)
    @Import({ProfileSecurityConfig.class, ProfileController.class, AuthController.class})
    static class MinimalApp {

        @RestController
        static class StubEndpoints {
            @GetMapping("/api/flights/live")
            String live() {
                return "live";
            }
        }
    }

    @Autowired
    private MockMvc mvc;

    /** The CSRF cookie the SPA reads off any response and echoes as a header. */
    private static Cookie csrfToken(MockMvc mvc) throws Exception {
        Cookie token = mvc.perform(get("/api/flights/live")).andReturn()
                .getResponse().getCookie("XSRF-TOKEN");
        assertThat(token).as("a readable XSRF-TOKEN cookie").isNotNull();
        return token;
    }

    @Test
    void logoutWithAValidTokenIsNoContentAndClearsTheSessionCookie() throws Exception {
        Cookie token = csrfToken(mvc);
        MockHttpSession session = new MockHttpSession();

        MvcResult result = mvc.perform(post("/api/auth/logout")
                        .session(session)
                        .cookie(token)
                        .header("X-XSRF-TOKEN", token.getValue()))
                .andExpect(status().isNoContent())
                .andReturn();

        assertThat(result.getResponse().getHeaders("Set-Cookie"))
                .as("the FT_SESSION cookie must be cleared")
                .anySatisfy(cookie -> {
                    assertThat(cookie).startsWith("FT_SESSION=");
                    assertThat(cookie).contains("Max-Age=0");
                });
        assertThat(session.isInvalid()).as("the server-side session must be invalidated").isTrue();
    }

    @Test
    void logoutWithoutATokenIsForbidden() throws Exception {
        MockHttpSession session = new MockHttpSession();

        mvc.perform(post("/api/auth/logout").session(session))
                .andExpect(status().isForbidden());

        assertThat(session.isInvalid()).as("a rejected logout must not touch the session").isFalse();
    }
}
