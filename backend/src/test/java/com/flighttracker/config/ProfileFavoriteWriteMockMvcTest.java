package com.flighttracker.config;

import com.flighttracker.controller.ProfileDataController;
import com.flighttracker.profile.ProfileProperties;
import com.flighttracker.profile.ProfileResolver;
import com.flighttracker.profile.SubjectHash;
import com.flighttracker.repository.FavoriteRepository;
import com.flighttracker.repository.ProfileRepository;
import jakarta.servlet.http.Cookie;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.jdbc.autoconfigure.DataSourceAutoConfiguration;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.oauth2.client.registration.ClientRegistration;
import org.springframework.security.oauth2.client.registration.ClientRegistrationRepository;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import javax.sql.DataSource;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.oidcLogin;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * Design section9-hq #84, step 5b-1 (D4): the favourite writes —
 * {@code PUT /api/profile/favorite} upserts one, {@code DELETE
 * /api/profile/favorite} removes one — with the real repositories against a
 * throwaway SQLite file, so the caps and the shapes are pinned end to end.
 *
 * <p>What is pinned: a signed-in write answers {@code 200} and stores the row,
 * a delete answers {@code 204} whether the row was there or not, a bad body or a
 * full profile answers {@code 400}/{@code 409} from the controller's own handler
 * (never a global one), the signed-out case is the chain's {@code 401}, and a
 * write with no CSRF token is a {@code 403}. No response ever carries the
 * profile id, the subject or its hash (design §3).
 */
@SpringBootTest(
        classes = ProfileFavoriteWriteMockMvcTest.MinimalApp.class,
        properties = {
                "spring.main.banner-mode=off",
                "flighttracker.profile.enabled=true",
                "server.servlet.session.cookie.secure=false",
                "flighttracker.oauth.google.client-id=test-client-id",
                "flighttracker.oauth.google.client-secret=test-client-secret",
                "flighttracker.profile.public-base-url=https://flight.pastabake.cloud"
        })
@AutoConfigureMockMvc
class ProfileFavoriteWriteMockMvcTest {

    private static final Instant NOW = Instant.parse("2026-10-01T12:00:00Z");
    private static final java.util.concurrent.atomic.AtomicInteger SEQ =
            new java.util.concurrent.atomic.AtomicInteger();
    private static final String ROUTE_DATA =
            "{\"origin\":\"ESSA\",\"destination\":\"ESGG\"}";

    @SpringBootConfiguration
    @EnableAutoConfiguration(exclude = DataSourceAutoConfiguration.class)
    @EnableConfigurationProperties({ProfileProperties.class, OAuthClientProperties.class})
    @Import({ProfileSecurityConfig.class, OAuthClientConfig.class, ProfileDataController.class,
            ProfileResolver.class, ProfileRepository.class, FavoriteRepository.class})
    static class MinimalApp {

        /** A throwaway SQLite file; the app's own schema.sql runs against it at startup. */
        @Bean
        DataSource dataSource() throws IOException {
            Path db = Files.createTempFile("profile-favorite-write-", ".db");
            db.toFile().deleteOnExit();
            return SqliteDataSourceConfig.buildDataSource(db.toString());
        }

        @Bean
        JdbcClient jdbcClient(DataSource dataSource) {
            return JdbcClient.create(dataSource);
        }

        /** A fixed clock so the resolved row and its timestamps are deterministic. */
        @Bean
        Clock clock() {
            return Clock.fixed(NOW, ZoneOffset.UTC);
        }

        /** A permitted GET the test reads the readable XSRF-TOKEN cookie off, as the SPA does. */
        @RestController
        static class PingEndpoint {
            @GetMapping("/api/ping")
            String ping() {
                return "ok";
            }
        }
    }

    @Autowired
    private MockMvc mvc;

    @Autowired
    private ClientRegistrationRepository registrations;

    @Autowired
    private ProfileRepository profiles;

    @Autowired
    private FavoriteRepository favorites;

    private Cookie csrfToken;

    /**
     * One fresh subject per test: the context (and its throwaway DB) is shared,
     * so a distinct subject keeps each test on its own profile and its own rows.
     */
    private String subject;

    @BeforeEach
    void readTheCsrfToken() throws Exception {
        subject = "profile-favorite-write-subject-" + SEQ.incrementAndGet();
        csrfToken = mvc.perform(get("/api/ping")).andReturn().getResponse().getCookie("XSRF-TOKEN");
        assertThat(csrfToken).as("a readable XSRF-TOKEN cookie").isNotNull();
    }

    /** A signed-in PUT of {@code body}, carrying the CSRF token the chain requires. */
    private MockHttpServletRequestBuilder signedInPut(String body) {
        return put("/api/profile/favorite")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body)
                .with(signedIn())
                .cookie(csrfToken)
                .header("X-XSRF-TOKEN", csrfToken.getValue());
    }

    private MockHttpServletRequestBuilder signedInDelete() {
        return delete("/api/profile/favorite")
                .param("kind", "route")
                .param("itemKey", "ESSA-ESGG")
                .with(signedIn())
                .cookie(csrfToken)
                .header("X-XSRF-TOKEN", csrfToken.getValue());
    }

    /** The app's own Google registration, with a known subject. */
    private org.springframework.test.web.servlet.request.RequestPostProcessor signedIn() {
        ClientRegistration google = registrations.findByRegistrationId(OAuthClientConfig.GOOGLE_REGISTRATION_ID);
        return oidcLogin().clientRegistration(google).idToken(token -> token.claim("sub", subject));
    }

    /** The profile the write resolved for {@link #subject}; its id is never exposed by the API. */
    private String profileId() {
        return profiles.findByProviderAndSubjectHash("google", SubjectHash.of("google", subject))
                .orElseThrow(() -> new AssertionError("the write must have created a profile row"))
                .id();
    }

    @Test
    void aSignedInWriteIsOkAndStoresTheRow() throws Exception {
        mvc.perform(signedInPut("{\"kind\":\"route\",\"itemKey\":\"ESSA-ESGG\",\"data\":" + ROUTE_DATA + "}"))
                .andExpect(status().isOk());

        assertThat(favorites.find(new FavoriteRepository.Key(profileId(), "route", "ESSA-ESGG")))
                .as("the favourite is stored under the resolved profile")
                .isPresent()
                .get()
                .extracting(favorite -> favorite.data())
                .asString()
                .contains("\"origin\":\"ESSA\"");
    }

    @Test
    void aSecondWriteOfTheSameKeyReplacesIt() throws Exception {
        String first = "{\"kind\":\"route\",\"itemKey\":\"ESSA-ESGG\",\"data\":{\"origin\":\"ESSA\"}}";
        String second = "{\"kind\":\"route\",\"itemKey\":\"ESSA-ESGG\",\"data\":{\"origin\":\"ESSA\",\"destination\":\"ESGG\"}}";

        mvc.perform(signedInPut(first)).andExpect(status().isOk());
        mvc.perform(signedInPut(second)).andExpect(status().isOk());

        assertThat(favorites.countForProfile(profileId())).as("the key is replaced, not duplicated").isEqualTo(1);
        assertThat(favorites.find(new FavoriteRepository.Key(profileId(), "route", "ESSA-ESGG")))
                .get().extracting(favorite -> favorite.data()).asString().contains("ESGG");
    }

    @Test
    void aDeleteRemovesTheRowAndAnswers204() throws Exception {
        mvc.perform(signedInPut("{\"kind\":\"route\",\"itemKey\":\"ESSA-ESGG\",\"data\":" + ROUTE_DATA + "}"))
                .andExpect(status().isOk());

        mvc.perform(signedInDelete()).andExpect(status().isNoContent());

        assertThat(favorites.find(new FavoriteRepository.Key(profileId(), "route", "ESSA-ESGG")))
                .as("the row is gone")
                .isEmpty();
    }

    @Test
    void aDeleteOfARowThatWasNeverThereIsStill204() throws Exception {
        mvc.perform(signedInDelete()).andExpect(status().isNoContent());
    }

    @Test
    void aMalformedOrOverCapWriteIsRejectedByTheControllerHandler() throws Exception {
        String[] bad = {
                "{\"itemKey\":\"ESSA-ESGG\",\"data\":{\"origin\":\"ESSA\"}}",            // kind missing
                "{\"kind\":\"  \",\"itemKey\":\"ESSA-ESGG\",\"data\":{\"origin\":\"ESSA\"}}", // kind blank
                "{\"kind\":\"route\",\"data\":{\"origin\":\"ESSA\"}}",                   // itemKey missing
                "{\"kind\":\"route\",\"itemKey\":\"\",\"data\":{\"origin\":\"ESSA\"}}",  // itemKey blank
                "{\"kind\":\"bogus\",\"itemKey\":\"ESSA-ESGG\",\"data\":{\"origin\":\"ESSA\"}}", // unknown kind
                "{\"kind\":\"route\",\"itemKey\":\"ESSA-ESGG\"}",                        // data missing
                "{\"kind\":\"route\",\"itemKey\":\"ESSA-ESGG\",\"data\":[1,2]}",         // data array
                "{\"kind\":\"route\",\"itemKey\":\"ESSA-ESGG\",\"data\":\"text\"}"       // data scalar
        };
        for (String body : bad) {
            mvc.perform(signedInPut(body))
                    .andExpect(status().isBadRequest())
                    .andExpect(jsonPath("$.field").isString());
        }

        mvc.perform(signedInPut("{\"kind\":\"route\",\"itemKey\":\"ESSA-ESGG\",\"data\":{\"origin\":\""
                        + "A".repeat(2100) + "\"}}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.field").value("data"));
    }

    @Test
    void aMissingOrBlankKeyOnDeleteIsA400() throws Exception {
        mvc.perform(delete("/api/profile/favorite").param("kind", "route").with(signedIn())
                        .cookie(csrfToken).header("X-XSRF-TOKEN", csrfToken.getValue()))
                .andExpect(status().isBadRequest());
        mvc.perform(delete("/api/profile/favorite").param("kind", "route").param("itemKey", "  ").with(signedIn())
                        .cookie(csrfToken).header("X-XSRF-TOKEN", csrfToken.getValue()))
                .andExpect(status().isBadRequest());
    }

    @Test
    void aWriteOverTheFavoriteCapIsA409AndWritesNothing() throws Exception {
        mvc.perform(signedInPut("{\"kind\":\"route\",\"itemKey\":\"K0\",\"data\":" + ROUTE_DATA + "}"))
                .andExpect(status().isOk());
        String id = profileId();
        for (int i = 1; i < 200; i++) {
            favorites.upsert(new FavoriteRepository.Key(id, "route", "K" + i), ROUTE_DATA);
        }
        assertThat(favorites.countForProfile(id)).isEqualTo(200);

        mvc.perform(signedInPut("{\"kind\":\"route\",\"itemKey\":\"K-OVER\",\"data\":" + ROUTE_DATA + "}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.field").value("favorites"));

        assertThat(favorites.countForProfile(id)).as("the cap write stored nothing").isEqualTo(200);
        assertThat(favorites.find(new FavoriteRepository.Key(id, "route", "K-OVER"))).isEmpty();
    }

    @Test
    void aSignedOutWriteIsUnauthorized() throws Exception {
        mvc.perform(put("/api/profile/favorite")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"kind\":\"route\",\"itemKey\":\"ESSA-ESGG\",\"data\":" + ROUTE_DATA + "}")
                        .cookie(csrfToken).header("X-XSRF-TOKEN", csrfToken.getValue()))
                .andExpect(status().isUnauthorized());
        mvc.perform(delete("/api/profile/favorite").param("kind", "route").param("itemKey", "ESSA-ESGG")
                        .cookie(csrfToken).header("X-XSRF-TOKEN", csrfToken.getValue()))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void aWriteWithoutACsrfTokenIsForbidden() throws Exception {
        mvc.perform(put("/api/profile/favorite")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"kind\":\"route\",\"itemKey\":\"ESSA-ESGG\",\"data\":" + ROUTE_DATA + "}")
                        .with(signedIn()))
                .andExpect(status().isForbidden());
    }

    @Test
    void anErrorBodyNeverCarriesTheProfileIdOrSubject() throws Exception {
        mvc.perform(signedInPut("{\"kind\":\"bogus\",\"itemKey\":\"ESSA-ESGG\",\"data\":{\"origin\":\"ESSA\"}}"))
                .andExpect(status().isBadRequest());

        String body = mvc.perform(signedInPut("{\"kind\":\"bogus\",\"itemKey\":\"ESSA-ESGG\",\"data\":{\"origin\":\"ESSA\"}}"))
                .andReturn().getResponse().getContentAsString();
        assertThat(body).doesNotContain(profileId()).doesNotContain(subject);
    }
}
