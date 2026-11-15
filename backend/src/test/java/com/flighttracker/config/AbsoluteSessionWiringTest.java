package com.flighttracker.config;

import com.flighttracker.controller.ProfileController;
import com.flighttracker.profile.ProfileProperties;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.jdbc.autoconfigure.DataSourceAutoConfiguration;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * Design section9-hq #84, step 3b-1: {@link AbsoluteSessionFilter} is installed
 * (and only installed) with {@code flighttracker.profile.enabled=true}, and it
 * really runs — a session past the cap is invalidated by an ordinary request
 * through the app's own filter set. The context's clock is fixed 31 days ahead so
 * any session created here is already past the 30-day cap.
 */
@SpringBootTest(
        classes = AbsoluteSessionWiringTest.MinimalApp.class,
        properties = {
                "spring.main.banner-mode=off",
                "flighttracker.profile.enabled=true",
                "server.servlet.session.cookie.secure=false"
        })
@AutoConfigureMockMvc
class AbsoluteSessionWiringTest {

    @SpringBootConfiguration
    @EnableAutoConfiguration(exclude = DataSourceAutoConfiguration.class)
    @EnableConfigurationProperties(ProfileProperties.class)
    @Import({ProfileSecurityConfig.class, ProfileController.class})
    static class MinimalApp {

        @Bean
        Clock clock() {
            return Clock.fixed(Instant.now().plus(Duration.ofDays(31)), ZoneOffset.UTC);
        }

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

    @Autowired
    private ApplicationContext context;

    @Test
    void theFilterIsInstalledWithTheFlagOn() {
        boolean installed = context.getBeansOfType(FilterRegistrationBean.class).values().stream()
                .map(FilterRegistrationBean::getFilter)
                .anyMatch(AbsoluteSessionFilter.class::isInstance);
        assertThat(installed).as("the absolute session cap must be registered with the flag on").isTrue();
    }

    @Test
    void aSessionPastTheCapIsInvalidatedByAnOrdinaryRequest() throws Exception {
        MockHttpSession session = new MockHttpSession();

        mvc.perform(get("/api/flights/live").session(session))
                .andExpect(status().isOk());

        assertThat(session.isInvalid())
                .as("a session past the cap must not survive a request through the chain")
                .isTrue();
    }
}
