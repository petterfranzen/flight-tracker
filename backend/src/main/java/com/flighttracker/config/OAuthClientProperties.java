package com.flighttracker.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * The env-supplied OAuth client registrations for optional social login
 * (design: section9-hq #84, step 3a — §1.3, §1.5, §4).
 *
 * <p>Every value here is a <em>name</em> in {@code application.yml} that reads an
 * environment variable, exactly like the OpenSky, Swedavia and AeroDataBox
 * credentials. The client id and secret themselves live only in
 * {@code /etc/flight-tracker/env} on the VM ({@code deploy/hetzner/env.example}),
 * never in the repo and never in an agent's environment.
 *
 * <p>A provider is offered only when <b>both</b> halves of its credential are
 * supplied: {@link Provider#configured()} gates the registration, so a provider
 * with no secret is simply off (design §4) — the sign-in option is not shown and
 * the registration is not built, not a broken provider.
 *
 * <p>The {@code *-uri} values default to the real provider endpoints; they are
 * overridable so the blackbox suite (a later step) can point a registration at
 * its local fake OIDC provider.
 */
@ConfigurationProperties(prefix = "flighttracker.oauth")
public class OAuthClientProperties {

    private Provider google = new Provider();

    private Provider github = new Provider();

    public Provider getGoogle() {
        return google;
    }

    public void setGoogle(Provider google) {
        this.google = google;
    }

    public Provider getGithub() {
        return github;
    }

    public void setGithub(Provider github) {
        this.github = github;
    }

    /** One provider's credential and endpoints. */
    public static class Provider {

        private String clientId = "";

        private String clientSecret = "";

        private String authorizationUri = "";

        private String tokenUri = "";

        /** OIDC only: where the id_token's signing keys are published. */
        private String jwkSetUri = "";

        /** OIDC only: the expected {@code iss} claim. */
        private String issuerUri = "";

        /** Plain OAuth2 only: the endpoint the user's account id is read from. */
        private String userInfoUri = "";

        /**
         * True when this provider can be registered at all. Missing either half
         * means the provider stays off; there is no code path for a half-supplied
         * credential.
         */
        public boolean configured() {
            return !clientId.isBlank() && !clientSecret.isBlank();
        }

        public String getClientId() {
            return clientId;
        }

        public void setClientId(String clientId) {
            this.clientId = clientId;
        }

        public String getClientSecret() {
            return clientSecret;
        }

        public void setClientSecret(String clientSecret) {
            this.clientSecret = clientSecret;
        }

        public String getAuthorizationUri() {
            return authorizationUri;
        }

        public void setAuthorizationUri(String authorizationUri) {
            this.authorizationUri = authorizationUri;
        }

        public String getTokenUri() {
            return tokenUri;
        }

        public void setTokenUri(String tokenUri) {
            this.tokenUri = tokenUri;
        }

        public String getJwkSetUri() {
            return jwkSetUri;
        }

        public void setJwkSetUri(String jwkSetUri) {
            this.jwkSetUri = jwkSetUri;
        }

        public String getIssuerUri() {
            return issuerUri;
        }

        public void setIssuerUri(String issuerUri) {
            this.issuerUri = issuerUri;
        }

        public String getUserInfoUri() {
            return userInfoUri;
        }

        public void setUserInfoUri(String userInfoUri) {
            this.userInfoUri = userInfoUri;
        }
    }
}
