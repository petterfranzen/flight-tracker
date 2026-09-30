package com.flighttracker.config;

import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.Resource;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.CacheControl;
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;
import org.springframework.web.servlet.resource.PathResourceResolver;

import java.io.IOException;
import java.util.concurrent.TimeUnit;

/**
 * Serves the built frontend SPA from the jar (cloud migration A1 — PLAN.md
 * §6 item 10): this process is now the only thing serving HTTP, so nginx's
 * old job of serving static files and falling back to index.html for
 * client-side routes moves here. CI's `with-frontend` Maven profile copies
 * frontend/dist/** into target/classes/static/ before packaging (see
 * ci-deployer's work package) — in a backend-only dev build, static/ is
 * simply empty and every unmatched path below falls through to Spring's
 * normal 404, which is the correct behaviour when there's no SPA to serve.
 *
 * The `/**` resource handler doesn't compete with `@RestController`
 * mappings for `/api/**` or the WebSocket upgrade handler at `/ws/live`:
 * Spring MVC's RequestMappingHandlerMapping (annotated controllers) and
 * the WebSocket handshake handler both have higher precedence than the
 * resource-handler HandlerMapping this configures, so DispatcherServlet
 * only ever falls through to static/SPA handling for a path neither of
 * those claims.
 *
 * @Order(HIGHEST_PRECEDENCE): makes sure this WebMvcConfigurer's
 * addResourceHandlers runs before Spring Boot's own auto-configured one
 * (WebMvcAutoConfiguration), so its registration for the static path
 * pattern ("/**") is already present by the time Boot's own checks
 * registry.hasMappingForPattern and skips registering a conflicting
 * duplicate for the same pattern.
 */
@Configuration
@Order(Ordered.HIGHEST_PRECEDENCE)
public class SpaWebConfig implements WebMvcConfigurer {

    @Override
    public void addResourceHandlers(ResourceHandlerRegistry registry) {
        // Vite's own content-hashed bundle files (index-<hash>.js, etc.) —
        // safe to cache for a year and mark immutable, since a new deploy
        // ships under a new hash rather than overwriting these.
        registry.addResourceHandler("/assets/**")
                .addResourceLocations("classpath:/static/assets/")
                .setCacheControl(CacheControl.maxAge(365, TimeUnit.DAYS).cachePublic().immutable());

        // Everything else: real static files (favicon, etc.) served as-is,
        // and any path that isn't one falls back to index.html — the SPA's
        // own client-side router then takes over. no-cache (not no-store):
        // the browser still revalidates with the server on every load
        // rather than serving a stale index.html from its local cache,
        // which matters here specifically because index.html is what
        // references the current build's hashed asset filenames.
        registry.addResourceHandler("/**")
                .addResourceLocations("classpath:/static/")
                .setCacheControl(CacheControl.noCache())
                .resourceChain(true)
                .addResolver(new SpaFallbackResourceResolver());
    }

    private static final class SpaFallbackResourceResolver extends PathResourceResolver {
        @Override
        protected Resource getResource(String resourcePath, Resource location) throws IOException {
            Resource requested = location.createRelative(resourcePath);
            if (requested.exists() && requested.isReadable()) {
                return requested;
            }
            // Backend-only dev build: no bundled frontend at all, nothing
            // to fall back to — let this fall through to a normal 404
            // instead of resolving to a resource that doesn't exist.
            Resource index = new ClassPathResource("static/index.html");
            return index.exists() ? index : null;
        }
    }
}
