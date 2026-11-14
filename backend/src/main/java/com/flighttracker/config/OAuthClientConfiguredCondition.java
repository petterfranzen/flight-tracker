package com.flighttracker.config;

import org.springframework.context.annotation.Condition;
import org.springframework.context.annotation.ConditionContext;
import org.springframework.core.env.Environment;
import org.springframework.core.type.AnnotatedTypeMetadata;

/**
 * Registers the OAuth2 clients only when at least one provider has both halves of
 * its credential (design: section9-hq #84, step 3a — §4). Unset providers have to
 * be <em>absent</em>, not blank, because Boot refuses to start on a registration
 * with an empty client id — so the registration bean carries this condition
 * instead of a {@code @ConditionalOnExpression}.
 *
 * <p>It evaluates the very same predicate the bean uses
 * ({@link OAuthClientProperties.Provider#configured(String, String)}) against the
 * environment, so the two can never disagree. That is what the old SpEL
 * expression got wrong in two ways: it treated a whitespace-only value as a
 * credential (so the bean was built and then threw "registrations cannot be
 * empty" at startup), and it inlined a client secret into a string literal, so a
 * quote in the secret was a parse error. Neither is possible against a plain
 * {@code String}.
 */
class OAuthClientConfiguredCondition implements Condition {

    @Override
    public boolean matches(ConditionContext context, AnnotatedTypeMetadata metadata) {
        Environment environment = context.getEnvironment();
        return providerConfigured(environment, "google") || providerConfigured(environment, "github");
    }

    private static boolean providerConfigured(Environment environment, String provider) {
        String prefix = "flighttracker.oauth." + provider + ".";
        return OAuthClientProperties.Provider.configured(
                environment.getProperty(prefix + "client-id"),
                environment.getProperty(prefix + "client-secret"));
    }
}
