package com.flighttracker.config;

import com.flighttracker.controller.ProfileController;
import com.flighttracker.profile.ProfileProperties;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.jdbc.autoconfigure.DataSourceAutoConfiguration;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.security.oauth2.client.registration.ClientRegistration;
import org.springframework.security.oauth2.client.registration.ClientRegistrationRepository;
import org.springframework.test.web.servlet.MockMvc;

import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.oidcLogin;
import static org.hamcrest.Matchers.startsWith;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * Design section9-hq #84 step 3a: the {@code SecurityMockMvc} / {@code oidcLogin()}
 * pair the design names as the acceptance test.
 *
 * <p>With {@code flighttracker.profile.enabled=true} a signed-out caller gets a
 * bare {@code 401} on {@code /api/profile} (no login redirect — account
 * enumeration, §5), and a signed-in one gets the provider id and nothing else
 * (§1.3). The registration the login is built from is the app's own, taken from
 * the repository {@link OAuthClientConfig} assembled, so the test exercises the
 * real configuration and not a stand-in.
 */
@SpringBootTest(
        classes = ProfileOidcLoginMockMvcTest.MinimalApp.class,
        properties = {
                "spring.main.banner-mode=off",
                "flighttracker.profile.enabled=true",
                "server.servlet.session.cookie.secure=false",
                "flighttracker.oauth.google.client-id=test-client-id",
                "flighttracker.oauth.google.client-secret=test-client-secret"
        })
@AutoConfigureMockMvc
class ProfileOidcLoginMockMvcTest {

    @SpringBootConfiguration
    @EnableAutoConfiguration(exclude = DataSourceAutoConfiguration.class)
    @EnableConfigurationProperties({ProfileProperties.class, OAuthClientProperties.class})
    @Import({ProfileSecurityConfig.class, OAuthClientConfig.class, ProfileController.class})
    static class MinimalApp {
    }

    @Autowired
    private MockMvc mvc;

    @Autowired
    private ClientRegistrationRepository registrations;

    @Test
    void anAnonymousProfileReadIsAnUnauthorized() throws Exception {
        mvc.perform(get("/api/profile"))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void aLoggedInUserGetsTheProviderIdAndNothingElse() throws Exception {
        ClientRegistration google = registrations.findByRegistrationId(OAuthClientConfig.GOOGLE_REGISTRATION_ID);
        mvc.perform(get("/api/profile")
                        .with(oidcLogin()
                                .clientRegistration(google)
                                .idToken(token -> token.claim("sub", "subject-123"))))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.provider").value("google"))
                // No email, no name, no avatar — only the provider (design §1.3).
                .andExpect(jsonPath("$.email").doesNotExist())
                .andExpect(jsonPath("$.name").doesNotExist());
    }

    @Test
    void theConfiguredProviderOffersAnAuthorizationRedirect() throws Exception {
        // oauth2Login is installed from the repository, so the provider whose id and
        // secret were supplied has a working authorization request endpoint that sends
        // the browser to the provider. (A request for an id that was not supplied throws
        // Spring's InvalidClientRegistrationIdException; nothing links to one, so it is
        // only reachable by hand-crafting the URL and is not pinned here.)
        mvc.perform(get("/oauth2/authorization/" + OAuthClientConfig.GOOGLE_REGISTRATION_ID))
                .andExpect(status().is3xxRedirection())
                .andExpect(header().string("Location",
                        startsWith("https://accounts.google.com/o/oauth2/v2/auth")));
    }
}
