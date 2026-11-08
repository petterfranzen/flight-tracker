package com.flighttracker.config;

import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpStatus;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.HttpStatusEntryPoint;
import org.springframework.security.oauth2.client.registration.ClientRegistrationRepository;
import org.springframework.security.web.csrf.CookieCsrfTokenRepository;

/**
 * The one thing optional social login changes in the request pipeline
 * (design: section9-hq #84, step 2 spike — §1.2 "the permitAll-default chain").
 *
 * <p>This is the <b>first Spring Security filter chain in the app</b>, and the
 * default is deny-by-default, so the chain here exists to <em>invert</em> that
 * default: every path that exists today stays open, and only
 * {@code /api/profile/**} is authenticated. A wrong matcher would silently lock
 * an endpoint (the map, {@code /ws/live}, {@code /api/flights/**}), which is
 * exactly the risk this slice pins with tests.
 *
 * <p>Everything is gated on {@code flighttracker.profile.enabled} (design §7,
 * default <b>false</b>):
 *
 * <ul>
 *   <li><b>Flag on</b> — the OAuth2-client chain below: permitAll everywhere,
 *       {@code /api/profile/**} authenticated, a session only when something
 *       asks for one ({@code IF_REQUIRED}), CSRF on but scoped so the existing
 *       anonymous {@code POST /api/agents/restart} is untouched, Google + GitHub
 *       from the registrations in {@code application.yml}.</li>
 *   <li><b>Flag off</b> (the production default) — a no-op chain that permits
 *       everything and creates no session, which also stops Spring Boot's own
 *       deny-all default chain from ever being built. An anonymous visit is
 *       unchanged: no cookie, no 401, nothing.</li>
 * </ul>
 */
@Configuration
public class ProfileSecurityConfig {

    /** The only paths that require a session; everything else permits anonymous use. */
    static final String PROFILE_PATHS = "/api/profile/**";

    /** The profile write API CSRF is scoped to; nothing else is ever token-checked. */
    static final String PROFILE_PREFIX = "/api/profile";

    /**
     * True only for a state-changing request the profile API owns. A safe method is
     * never token-checked (so a GET /api/profile still reads), and no other path is
     * touched, so CSRF on cannot 403 an endpoint that works today.
     */
    static boolean isProfileWrite(jakarta.servlet.http.HttpServletRequest request) {
        String method = request.getMethod();
        boolean unsafe = "POST".equals(method) || "PUT".equals(method)
                || "DELETE".equals(method) || "PATCH".equals(method);
        return unsafe && request.getRequestURI() != null && request.getRequestURI().startsWith(PROFILE_PREFIX);
    }

    @Bean
    @ConditionalOnProperty(prefix = "flighttracker.profile", name = "enabled", havingValue = "true")
    SecurityFilterChain profileSecurityFilterChain(
            HttpSecurity http, ObjectProvider<ClientRegistrationRepository> registrations) throws Exception {
        http
                // CSRF on, but SCOPED to the profile write API. A blanket CSRF config
                // silently changes every other anonymous POST: the blackbox suite caught
                // `POST /api/health` flipping from 405 (method not allowed) to 403, which
                // is a client-visible behaviour change for a route the feature does not
                // own. The matcher below therefore requires a token only for a state-
                // changing request under /api/profile, so /api/agents/** and every other
                // existing route behave exactly as before. `.spa()` is Spring Security 7's
                // built-in SPA handler (readable XSRF-TOKEN cookie the frontend echoes).
                .csrf(csrf -> csrf
                        .csrfTokenRepository(CookieCsrfTokenRepository.withHttpOnlyFalse())
                        .spa()
                        .requireCsrfProtectionMatcher(ProfileSecurityConfig::isProfileWrite))
                .authorizeHttpRequests(auth -> auth
                        .requestMatchers(PROFILE_PATHS).authenticated()
                        .anyRequest().permitAll())
                // A session is created only when the login flow (or a profile write) asks
                // for one, so a map-only visit still sets no cookie at all.
                .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.IF_REQUIRED))
                // No login page and no redirect for the API: an anonymous profile read is a
                // plain 401 (design §5, account enumeration).
                .exceptionHandling(entry -> entry.authenticationEntryPoint(new HttpStatusEntryPoint(HttpStatus.UNAUTHORIZED)))
                // The API logout (POST /api/auth/logout) is a later step; don't add Spring's
                // own GET /logout page in the meantime.
                .logout(AbstractHttpConfigurer::disable);
        // A provider is "off" when no registration exists for it (design §4/§7): with no
        // client-id and secret supplied there is no ClientRegistrationRepository bean, so
        // the login filter is simply not installed — no sign-in offered, not a broken app.
        if (registrations.getIfAvailable() != null) {
            http.oauth2Login(Customizer.withDefaults());
        }
        return http.build();
    }

    @Bean
    @ConditionalOnProperty(prefix = "flighttracker.profile", name = "enabled", havingValue = "false", matchIfMissing = true)
    SecurityFilterChain anonymousSecurityFilterChain(HttpSecurity http) throws Exception {
        http
                .csrf(AbstractHttpConfigurer::disable)
                // The app's own SecurityHeadersFilter owns every response header; Spring
                // Security must not add a second set on the off path.
                .headers(AbstractHttpConfigurer::disable)
                .requestCache(AbstractHttpConfigurer::disable)
                .logout(AbstractHttpConfigurer::disable)
                .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .authorizeHttpRequests(auth -> auth.anyRequest().permitAll());
        return http.build();
    }
}
