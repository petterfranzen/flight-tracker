package com.flighttracker.config;

import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpStatus;
import org.springframework.security.config.annotation.web.configuration.WebSecurityCustomizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.HttpStatusEntryPoint;
import org.springframework.security.oauth2.client.registration.ClientRegistrationRepository;
import org.springframework.security.oauth2.client.userinfo.OAuth2UserRequest;
import org.springframework.security.oauth2.client.userinfo.OAuth2UserService;
import org.springframework.security.oauth2.core.user.OAuth2User;
import org.springframework.security.web.authentication.SimpleUrlAuthenticationFailureHandler;
import org.springframework.security.web.csrf.CookieCsrfTokenRepository;
import org.springframework.security.web.firewall.DefaultHttpFirewall;
import org.springframework.util.AntPathMatcher;

import java.time.Clock;
import java.util.List;

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
 * <p><b>Flag-on hardening (step 3b-2, section9-hq #324)</b> — the reviewer's
 * should-fix list for the flag-on path, now applied:
 *
 * <ul>
 *   <li>One owner for the response headers: the flag-on chain disables Spring
 *       Security's header writer, so the app's own {@link SecurityHeadersFilter}
 *       owns every header (CSP included) exactly as it does with the flag off,
 *       and nothing adds a second {@code Cache-Control}, {@code Pragma},
 *       {@code X-XSS-Protection} or {@code X-Frame-Options} on top.</li>
 *   <li>The header filter is ordered <em>ahead</em> of the chain
 *       ({@link SecurityHeadersFilter#ORDER}, before Spring Security's
 *       {@code -100}), so the responses the chain itself writes — the 401, the
 *       CSRF 403, the {@code /oauth2/authorization/*} and
 *       {@code /login/oauth2/code/*} 302s, the StrictHttpFirewall 400 and an
 *       unknown-registration 500 — carry the app headers too.
 *       {@link SecurityHeadersFilter} also re-adds {@code Cache-Control:
 *       no-store} on the feature's own paths ({@code /api/profile/**},
 *       {@code /api/auth/**}, the two OAuth redirects), the value Spring's header
 *       writer used to supply. The ordering change is only observable with the
 *       flag on: it covers responses the chain writes itself, and the flag-off
 *       chain writes none that its container did not already write with the app
 *       headers present.</li>
 *   <li>No generated {@code GET /login} page: {@code oauth2Login} is told the
 *       login page is {@link #LOGIN_PAGE} ({@code /}, the SPA, which offers
 *       sign-in itself), which stops Spring installing its default page and its
 *       {@code /login?error} redirect. An anonymous profile read is still a
 *       plain 401.</li>
 *   <li>A failed login redirects to a <b>relative</b> {@code /?error} instead of
 *       the default absolute {@code http://<Host>/?error}, so the internal
 *       host/port does not reach a {@code Location} header the browser follows
 *       (section9-hq #326, optional).</li>
 *   <li>The CSRF matcher is the authorize matcher: both rules are built from
 *       {@link #AUTHENTICATED_PATHS} and {@link #CSRF_PROTECTED_PATHS}, so a
 *       write to {@code /api/profileX} is no longer token-checked.</li>
 * </ul>
 *
 * <p><b>Still open before the flag is enabled</b> (not part of this slice):
 *
 * <ul>
 *   <li>No test drives a WebSocket handshake or an {@code Origin} rejection
 *       with the flag on.</li>
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

    /** Sign-out (step 3b-1): a state-changing POST that must carry a token like a profile write. */
    static final String LOGOUT_PATH = "/api/auth/logout";

    /**
     * The single source of truth for "requires a session": the set the authorize rule
     * protects, and the set its tests read back, so the CSRF rule cannot silently drift
     * from it. Adding a path here adds it to both rules.
     */
    static final List<String> AUTHENTICATED_PATHS = List.of(PROFILE_PATHS);

    /**
     * The paths CSRF guards a state-changing request on: exactly the authorize set, plus
     * the sign-out POST (step 3b-1). Nothing else is ever token-checked, so CSRF on cannot
     * 403 an endpoint that works today (notably {@code POST /api/health}, which keeps its
     * 405 rather than becoming a 403).
     */
    static final List<String> CSRF_PROTECTED_PATHS = List.of(PROFILE_PATHS, LOGOUT_PATH);

    /**
     * The URL Spring Security is told the login page lives at. There is no server-rendered
     * login page (design §5: account enumeration) — {@code /} is the SPA, which offers
     * sign-in itself — and naming any URL here stops {@code oauth2Login} from installing
     * its generated {@code GET /login} page. Unauthenticated API calls are the plain 401
     * below, never a redirect.
     */
    static final String LOGIN_PAGE = "/";

    /** Path-pattern semantics, the same the authorize rule's string patterns are matched with. */
    private static final AntPathMatcher PATH_MATCHER = new AntPathMatcher();

    /**
     * True only for a state-changing request the feature owns: a profile write, or
     * {@code POST /api/auth/logout}. A safe method is never token-checked (so a
     * {@code GET /api/profile} still reads), and no other path is touched, so CSRF
     * on cannot 403 an endpoint that works today (notably {@code POST /api/health},
     * which must keep its 405 rather than become a 403).
     */
    static boolean isCsrfProtectedWrite(jakarta.servlet.http.HttpServletRequest request) {
        String method = request.getMethod();
        boolean unsafe = "POST".equals(method) || "PUT".equals(method)
                || "DELETE".equals(method) || "PATCH".equals(method);
        if (!unsafe) {
            return false;
        }
        String uri = request.getRequestURI();
        // The same path patterns the authorize rule protects — a write to /api/profileX is
        // no longer token-checked — plus the sign-out POST.
        return uri != null && CSRF_PROTECTED_PATHS.stream()
                .anyMatch(pattern -> PATH_MATCHER.match(pattern, uri));
    }

    @Bean
    @ConditionalOnProperty(prefix = "flighttracker.profile", name = "enabled", havingValue = "true")
    SecurityFilterChain profileSecurityFilterChain(
            HttpSecurity http,
            ObjectProvider<ClientRegistrationRepository> registrations,
            ObjectProvider<OAuth2UserService<OAuth2UserRequest, OAuth2User>> oauth2UserService)
            throws Exception {
        http
                // One owner for the response headers: the app's own SecurityHeadersFilter.
                // Spring Security's header writer would otherwise add its defaults on top
                // of that (Cache-Control, Pragma, Expires, X-XSS-Protection, and a second
                // X-Frame-Options), so the chain leaves every header to the app filter.
                .headers(AbstractHttpConfigurer::disable)
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
                        .requireCsrfProtectionMatcher(ProfileSecurityConfig::isCsrfProtectedWrite))
                .authorizeHttpRequests(auth -> auth
                        .requestMatchers(AUTHENTICATED_PATHS.toArray(String[]::new)).authenticated()
                        .anyRequest().permitAll())
                // A session is created only when the login flow (or a profile write) asks
                // for one, so a map-only visit still sets no cookie at all.
                .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.IF_REQUIRED))
                // No login page and no redirect for the API: an anonymous profile read is a
                // plain 401 (design §5, account enumeration).
                .exceptionHandling(entry -> entry.authenticationEntryPoint(new HttpStatusEntryPoint(HttpStatus.UNAUTHORIZED)))
                // Sign-out is the app's own POST /api/auth/logout (AuthController); Spring
                // Security's LogoutFilter and its generated GET /logout page stay off, so no
                // extra unauthenticated route appears.
                .logout(AbstractHttpConfigurer::disable);
        // A provider is "off" when no registration exists for it (design §4/§7): with no
        // client-id and secret supplied there is no ClientRegistrationRepository bean, so
        // the login filter is simply not installed — no sign-in offered, not a broken app.
        if (registrations.getIfAvailable() != null) {
            OAuth2UserService<OAuth2UserRequest, OAuth2User> idOnly = oauth2UserService.getIfAvailable();
            SimpleUrlAuthenticationFailureHandler loginFailure = loginFailureRedirect();
            if (idOnly != null) {
                // GitHub is plain OAuth2 and its /user returns a login, a name, an avatar
                // and an email even at no scope; keep only the account id (design §1.5).
                // Google is OIDC and reads its id_token, so this never runs for it.
                http.oauth2Login(oauth2 -> oauth2
                        .loginPage(LOGIN_PAGE)
                        .failureHandler(loginFailure)
                        .userInfoEndpoint(userInfo -> userInfo.userService(idOnly)));
            } else {
                // No user service supplied (a test context): still no generated login page.
                http.oauth2Login(oauth2 -> oauth2
                        .loginPage(LOGIN_PAGE)
                        .failureHandler(loginFailure));
            }
        }
        return http.build();
    }

    /**
     * A failed login (a callback with no {@code state}, a provider that refused the code)
     * sends the browser back to the SPA's sign-in with {@code ?error}, as a <b>relative</b>
     * {@code Location}. The default handler redirects to the absolute
     * {@code http://<Host>/?error}, which leaks the internal host/port in a header the browser
     * then follows; a root-relative {@code /?error} is all the SPA needs. The status is a plain
     * {@code 302}, the same the default strategy writes.
     */
    private static SimpleUrlAuthenticationFailureHandler loginFailureRedirect() {
        SimpleUrlAuthenticationFailureHandler failure =
                new SimpleUrlAuthenticationFailureHandler(LOGIN_PAGE + "?error");
        failure.setRedirectStrategy((request, response, url) -> {
            response.setStatus(HttpStatus.FOUND.value());
            response.setHeader(org.springframework.http.HttpHeaders.LOCATION, url);
        });
        return failure;
    }

    /**
     * The absolute session cap (step 3b-1): a session older than
     * {@link AbsoluteSessionFilter#ABSOLUTE_SESSION_CAP} is invalidated on the next
     * request, whatever its idle time. Ordered ahead of Spring Security's own filter
     * chain (registered at order {@code -100}) so an expired session cannot
     * authenticate the request that discovers it. Only installed with the flag on;
     * the {@link Clock} is taken from the context when present and from the system
     * clock otherwise, so a minimal test context needs no clock bean.
     */
    @Bean
    @ConditionalOnProperty(prefix = "flighttracker.profile", name = "enabled", havingValue = "true")
    FilterRegistrationBean<AbsoluteSessionFilter> absoluteSessionFilter(ObjectProvider<Clock> clock) {
        AbsoluteSessionFilter filter = new AbsoluteSessionFilter(
                AbsoluteSessionFilter.ABSOLUTE_SESSION_CAP, clock.getIfAvailable(Clock::systemUTC));
        FilterRegistrationBean<AbsoluteSessionFilter> registration = new FilterRegistrationBean<>(filter);
        registration.addUrlPatterns("/*");
        registration.setOrder(-110);
        return registration;
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
