package com.flighttracker.config;

import com.flighttracker.controller.ProfileController;
import com.flighttracker.controller.ProfileDataController;
import com.flighttracker.profile.ProfileProperties;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.ApplicationContext;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.jdbc.autoconfigure.DataSourceAutoConfiguration;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.security.oauth2.client.registration.ClientRegistrationRepository;
import org.springframework.test.web.servlet.MockMvc;

import static org.assertj.core.api.Assertions.assertThat;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * Design section9-hq #84 step 3a acceptance, the production default: with
 * {@code flighttracker.profile.enabled=false} — even when credentials are in the
 * environment — no OAuth client is wired and {@code /api/profile} answers
 * {@code 503}, which is how the SPA hides the sign-in control instead of showing
 * a broken one (§7). The anonymous path is otherwise untouched; the byte-for-byte
 * header and status contract is pinned in {@code ProfileSecurityFlagOffTest}.
 */
@SpringBootTest(
        classes = ProfileFlagOffMockMvcTest.MinimalApp.class,
        properties = {
                "spring.main.banner-mode=off",
                "flighttracker.profile.enabled=false",
                "flighttracker.oauth.google.client-id=test-client-id",
                "flighttracker.oauth.google.client-secret=test-client-secret"
        })
@AutoConfigureMockMvc
class ProfileFlagOffMockMvcTest {

    @SpringBootConfiguration
    @EnableAutoConfiguration(exclude = DataSourceAutoConfiguration.class)
    @EnableConfigurationProperties({ProfileProperties.class, OAuthClientProperties.class})
    @Import({ProfileSecurityConfig.class, OAuthClientConfig.class, ProfileController.class,
            ProfileDataController.class})
    static class MinimalApp {
    }

    @Autowired
    private MockMvc mvc;

    @Autowired
    private ApplicationContext context;

    @Test
    void theProfileEndpointAnswers503WithTheFlagOff() throws Exception {
        mvc.perform(get("/api/profile"))
                .andExpect(status().isServiceUnavailable());
    }

    @Test
    void theFavoriteWritePathsDoNotExistWithTheFlagOff() throws Exception {
        // On main today there is no mapping on this path, so the flag-off build must
        // answer the same 404, never a write: the controller bean is not created.
        mvc.perform(put("/api/profile/favorite")
                        .contentType(org.springframework.http.MediaType.APPLICATION_JSON)
                        .content("{\"kind\":\"route\",\"itemKey\":\"ESSA-ESGG\",\"data\":{}}"))
                .andExpect(status().isNotFound());
        mvc.perform(delete("/api/profile/favorite").param("kind", "route").param("itemKey", "ESSA-ESGG"))
                .andExpect(status().isNotFound());
    }

    @Test
    void noProfileDataControllerIsWiredWithTheFlagOff() {
        assertThat(context.getBeanProvider(ProfileDataController.class).getIfAvailable())
                .as("the favourite write controller is gated on the flag")
                .isNull();
    }

    @Test
    void noOAuthClientIsWiredEvenWhenCredentialsArePresent() {
        // OAuthClientConfig is gated on the flag, so nothing is registered at all.
        assertThat(context.getBeanProvider(ClientRegistrationRepository.class).getIfAvailable())
                .as("no registration with the flag off")
                .isNull();
    }
}
