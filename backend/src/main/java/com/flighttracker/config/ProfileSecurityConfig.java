package com.flighttracker.config;

import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpStatus;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.configuration.WebSecurityCustomizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.HttpStatusEntryPoint;
import org.springframework.security.oauth2.client.registration.ClientRegistrationRepository;
import org.springframework.security.web.csrf.CookieCsrfTokenRepository;
import org.springframework.security.web.firewall.DefaultHttpFirewall;

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
 *       from the env-supplied registrations in {@link OAuthClientConfig}.</li>
 *   <li><b>Flag off</b> (the production default) — a no-op chain that permits
 *       everything and creates no session, which also stops Spring Boot's own
 *       deny-all default chain from ever being built. An anonymous visit is
 *       unchanged: no cookie, no 401, nothing.</li>
 * </ul>
 *
 * <p><b>TODO before the flag is ever turned on</b> (the reviewer's should-fix
 * list for the flag-on path; none of it is a defect while the flag is off):
 *
 * <ul>
 *   <li>Flag on, {@code .headers()} is left at Spring Security's defaults while
 *       the app's own {@link SecurityHeadersFilter} owns headers, so responses
 *       can get a second/duplicate {@code X-Frame-Options},
 *       {@code X-Content-Type-Options}, HSTS and {@code Cache-Control} set.
 *       Decide one owner and pin the response headers (CSP included) with the
 *       flag on.</li>
 *   <li>{@code oauth2Login(Customizer.withDefaults())} also installs Spring
 *       Security's generated {@code GET /login} page and {@code /login?error}
 *       redirect, which contradicts the "no login page, plain 401" comment
 *       below. Set {@code loginPage}/{@code failureHandler} explicitly.</li>
 *   <li>No test drives a WebSocket handshake or an {@code Origin} rejection
 *       with the flag on.</li>
 *   <li>{@link #isProfileWrite} uses {@code startsWith("/api/profile")}, so a
 *       write to {@code /api/profileX} is token-checked too. Harmless, but use
 *       the same matcher as the authorize rule.</li>
 *   <li>Cross-PR: the service worker (#182) answers every same-origin
 *       navigation from its cached {@code index.html} except {@code /api} and
 *       {@code /ws}; {@code /oauth2/authorization/*} and
 *       {@code /login/oauth2/code/*} are navigations, so they must be added to
 *       the worker's bypass list before the flag is enabled.</li>
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

    /**
     * With the flag off the app must be byte-identical to the pre-Spring-Security
     * build. The one thing a bare chain still does to a request is front it with a
     * firewall, and the default
     * {@link org.springframework.security.web.firewall.StrictHttpFirewall} rejects
     * {@code //}, {@code ;}, {@code %2e}/{@code %25}, backslashes and control
     * characters with a {@code 400} that carries none of the app's headers, where
     * Tomcat/MVC used to answer them itself ({@code 404}, or {@code 200} for a path
     * parameter). That would be a real change to the production default, so with the
     * flag off we install {@link DefaultHttpFirewall} — the firewall Spring Security
     * shipped before Strict: it sanitizes rather than rejects, and it is still at
     * least as strict as the container on its own, which is all that fronted these
     * paths before this slice. The flag-on chain keeps Strict.
     *
     * <p>This is why the off path also needs a chain at all: Spring Boot only skips
     * its own deny-all default chain when one {@code SecurityFilterChain} bean
     * exists, so removing the chain would lock the app rather than free it.
     */
    @Bean
    @ConditionalOnProperty(prefix = "flighttracker.profile", name = "enabled", havingValue = "false", matchIfMissing = true)
    WebSecurityCustomizer flagOffLeavesRequestsToTheContainer() {
        return web -> web.httpFirewall(new DefaultHttpFirewall());
    }
}
