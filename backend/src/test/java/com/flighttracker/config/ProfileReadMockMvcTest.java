package com.flighttracker.config;

import com.flighttracker.controller.ProfileController;
import com.flighttracker.profile.ProfileProperties;
import com.flighttracker.profile.ProfileReader;
import com.flighttracker.profile.ProfileResolver;
import com.flighttracker.profile.SubjectHash;
import com.flighttracker.repository.FavoriteRepository;
import com.flighttracker.repository.ProfileRepository;
import com.flighttracker.repository.WatchedFlightRepository;
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
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.oauth2.client.registration.ClientRegistration;
import org.springframework.security.oauth2.client.registration.ClientRegistrationRepository;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

import javax.sql.DataSource;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.oidcLogin;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * Design section9-hq #84, step 5a-2 (D4): {@code GET /api/profile} returns
 * {@code {provider, favorites, watched}} for the signed-in user, the lists read
 * back from the profile's own rows.
 *
 * <p>Unlike the chain tests, this one wires the <b>real</b> read: a throwaway
 * SQLite file the app's own {@code schema.sql} is run against, the real
 * repositories, {@link ProfileResolver} and {@link ProfileReader}, and a session
 * from {@code oidcLogin()}. So it pins the two shapes the SPA depends on — a
 * brand-new profile is two empty lists, and a profile with rows gets them back
 * without the server-side profile id or subject anywhere in the body (design §3).
 */
@SpringBootTest(
        classes = ProfileReadMockMvcTest.MinimalApp.class,
        properties = {
                "spring.main.banner-mode=off",
                "flighttracker.profile.enabled=true",
                "server.servlet.session.cookie.secure=false",
                "flighttracker.oauth.google.client-id=test-client-id",
                "flighttracker.oauth.google.client-secret=test-client-secret",
                "flighttracker.profile.public-base-url=https://flight.pastabake.cloud"
        })
@AutoConfigureMockMvc
class ProfileReadMockMvcTest {

    private static final Instant NOW = Instant.parse("2026-10-01T12:00:00Z");
    private static final String SUBJECT = "profile-read-subject-1";

    @SpringBootConfiguration
    @EnableAutoConfiguration(exclude = DataSourceAutoConfiguration.class)
    @EnableConfigurationProperties({ProfileProperties.class, OAuthClientProperties.class})
    @Import({ProfileSecurityConfig.class, OAuthClientConfig.class, ProfileController.class,
            ProfileResolver.class, ProfileReader.class,
            ProfileRepository.class, FavoriteRepository.class, WatchedFlightRepository.class})
    static class MinimalApp {

        /** A throwaway SQLite file; the app's own schema.sql runs against it at startup. */
        @Bean
        DataSource dataSource() throws IOException {
            Path db = Files.createTempFile("profile-read-", ".db");
            db.toFile().deleteOnExit();
            return SqliteDataSourceConfig.buildDataSource(db.toString());
        }

        @Bean
        JdbcClient jdbcClient(DataSource dataSource) {
            return JdbcClient.create(dataSource);
        }

        /** A fixed clock so a resolved row and its timestamps are deterministic. */
        @Bean
        Clock clock() {
            return Clock.fixed(NOW, ZoneOffset.UTC);
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

    @Autowired
    private WatchedFlightRepository watched;

    /** A signed-in read: the app's own Google registration, with a known subject. */
    private MockHttpServletRequestBuilder signedInRead() {
        ClientRegistration google = registrations.findByRegistrationId(OAuthClientConfig.GOOGLE_REGISTRATION_ID);
        return get("/api/profile")
                .with(oidcLogin()
                        .clientRegistration(google)
                        .idToken(token -> token.claim("sub", SUBJECT)));
    }

    /** The profile the read resolved/created for {@link #SUBJECT}. */
    private String profileId() {
        return profiles.findByProviderAndSubjectHash("google", SubjectHash.of("google", SUBJECT))
                .orElseThrow(() -> new AssertionError("the read must have created a profile row"))
                .id();
    }

    @Test
    void aSignedInReadOfANewProfileIsTheProviderAndTwoEmptyLists() throws Exception {
        mvc.perform(signedInRead())
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.provider").value("google"))
                .andExpect(jsonPath("$.favorites").isArray())
                .andExpect(jsonPath("$.favorites").isEmpty())
                .andExpect(jsonPath("$.watched").isArray())
                .andExpect(jsonPath("$.watched").isEmpty())
                // The profile id, subject and its hash are server-side only (design §3).
                .andExpect(jsonPath("$.id").doesNotExist())
                .andExpect(jsonPath("$.subject").doesNotExist())
                .andExpect(jsonPath("$.email").doesNotExist())
                .andExpect(jsonPath("$.name").doesNotExist());

        assertThat(profiles.findByProviderAndSubjectHash("google", SubjectHash.of("google", SUBJECT)))
                .as("a first read resolves the profile, creating the row")
                .isPresent();
    }

    @Test
    void aSignedInReadReturnsTheProfilesOwnFavoritesAndWatchedFlights() throws Exception {
        String id = profileIdAfter((signedInRead()));

        favorites.upsert(id, "route", "ESSA-ESGG",
                "{\"origin\":\"ESSA\",\"originName\":\"Stockholm-Arlanda\",\"originIata\":\"ARN\","
                        + "\"destination\":\"ESGG\",\"destinationName\":\"Goteborg-Landvetter\",\"destinationIata\":\"GOT\"}");
        favorites.upsert(id, "aircraft", "48415e",
                "{\"icao24\":\"48415e\",\"registration\":\"PH-BXA\",\"callsign\":\"KL1234\"}");
        watched.upsert(id, "SK123", "2026-10-02", "ESSA", "to Gothenburg");

        mvc.perform(signedInRead())
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.provider").value("google"))
                // Both kinds of favourite come back, ordered by kind then key.
                .andExpect(jsonPath("$.favorites.length()").value(2))
                .andExpect(jsonPath("$.favorites[0].kind").value("aircraft"))
                .andExpect(jsonPath("$.favorites[0].itemKey").value("48415e"))
                .andExpect(jsonPath("$.favorites[0].data.icao24").value("48415e"))
                .andExpect(jsonPath("$.favorites[1].kind").value("route"))
                .andExpect(jsonPath("$.favorites[1].data.origin").value("ESSA"))
                // The server-side profile id never leaks into a favourite.
                .andExpect(jsonPath("$.favorites[0].profileId").doesNotExist())
                .andExpect(jsonPath("$.watched.length()").value(1))
                .andExpect(jsonPath("$.watched[0].flightNumber").value("SK123"))
                .andExpect(jsonPath("$.watched[0].flightDate").value("2026-10-02"))
                .andExpect(jsonPath("$.watched[0].airport").value("ESSA"))
                .andExpect(jsonPath("$.watched[0].label").value("to Gothenburg"))
                .andExpect(jsonPath("$.watched[0].profileId").doesNotExist());
    }

    /** Runs a signed-in read (which resolves the profile) and returns its id. */
    private String profileIdAfter(MockHttpServletRequestBuilder read) throws Exception {
        mvc.perform(read).andExpect(status().isOk());
        return profileId();
    }
}
