package com.flighttracker.config;

import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jose.jwk.gen.RSAKeyGenerator;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Date;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * The hermetic fake OIDC provider the step-2 spike drives a real login through
 * (design section9-hq #84 §4 item 1): Authorization + Token + JWKS on loopback,
 * with a keypair generated here that never touches production.
 *
 * <p>It is deliberately small: it answers discovery, mints a code on
 * {@code /authorize} (echoing {@code state} and remembering the {@code nonce}),
 * and on {@code /token} returns an {@code id_token} signed with its own key.
 * Nothing about the code or the PKCE challenge is verified — the point is the
 * <em>app's</em> half of the flow, not a second provider implementation.
 */
final class FakeOidcProvider implements AutoCloseable {

    static final String CLIENT_ID = "flight-tracker-test-client";
    static final String CLIENT_SECRET = "test-client-secret";
    static final String SUBJECT = "fake-subject-12345";

    private final HttpServer server;
    private final RSAKey signingKey;
    private final String issuer;
    private final Map<String, String> nonceByCode = new HashMap<>();
    private final AtomicInteger codes = new AtomicInteger();

    FakeOidcProvider() throws Exception {
        this.signingKey = new RSAKeyGenerator(2048).keyID("fake-oidc-key").generate();
        this.server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        this.issuer = "http://127.0.0.1:" + server.getAddress().getPort();
        server.createContext("/.well-known/openid-configuration", this::discovery);
        server.createContext("/authorize", this::authorize);
        server.createContext("/token", this::token);
        server.createContext("/jwks", this::jwks);
        server.start();
    }

    String issuer() {
        return issuer;
    }

    String redirectUriTemplate() {
        return "{baseUrl}/login/oauth2/code/{registrationId}";
    }

    private void discovery(HttpExchange exchange) throws IOException {
        String body = """
                {"issuer":"%s",
                 "authorization_endpoint":"%s/authorize",
                 "token_endpoint":"%s/token",
                 "jwks_uri":"%s/jwks",
                 "response_types_supported":["code"],
                 "subject_types_supported":["public"],
                 "id_token_signing_alg_values_supported":["RS256"],
                 "scopes_supported":["openid"]}
                """.formatted(issuer, issuer, issuer, issuer);
        respondJson(exchange, 200, body);
    }

    private void jwks(HttpExchange exchange) throws IOException {
        respondJson(exchange, 200, new JWKSet(signingKey.toPublicJWK()).toString());
    }

    private void authorize(HttpExchange exchange) throws IOException {
        Map<String, String> query = parseForm(exchange.getRequestURI().getRawQuery());
        String code = "code-" + codes.incrementAndGet();
        nonceByCode.put(code, query.getOrDefault("nonce", ""));
        String location = query.get("redirect_uri")
                + "?code=" + enc(code)
                + "&state=" + enc(query.getOrDefault("state", ""));
        exchange.getResponseHeaders().add("Location", location);
        exchange.sendResponseHeaders(302, -1);
        exchange.close();
    }

    private void token(HttpExchange exchange) throws IOException {
        Map<String, String> form = parseForm(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
        String code = form.get("code");
        Instant now = Instant.now();
        JWTClaimsSet claims = new JWTClaimsSet.Builder()
                .issuer(issuer)
                .subject(SUBJECT)
                .audience(CLIENT_ID)
                .issueTime(Date.from(now))
                .expirationTime(Date.from(now.plusSeconds(300)))
                .claim("nonce", nonceByCode.getOrDefault(code, ""))
                .build();
        String idToken;
        try {
            SignedJWT jwt = new SignedJWT(
                    new JWSHeader.Builder(JWSAlgorithm.RS256).keyID(signingKey.getKeyID()).build(), claims);
            jwt.sign(new RSASSASigner(signingKey));
            idToken = jwt.serialize();
        } catch (Exception e) {
            throw new IOException("could not sign the id_token", e);
        }
        respondJson(exchange, 200, """
                {"access_token":"fake-access-token",
                 "token_type":"Bearer",
                 "expires_in":300,
                 "id_token":"%s"}
                """.formatted(idToken));
    }

    private static Map<String, String> parseForm(String raw) {
        Map<String, String> out = new HashMap<>();
        if (raw == null || raw.isBlank()) {
            return out;
        }
        for (String pair : raw.split("&")) {
            int eq = pair.indexOf('=');
            if (eq < 0) {
                continue;
            }
            out.put(dec(pair.substring(0, eq)), dec(pair.substring(eq + 1)));
        }
        return out;
    }

    private static String dec(String value) {
        return URLDecoder.decode(value, StandardCharsets.UTF_8);
    }

    private static String enc(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }

    private static void respondJson(HttpExchange exchange, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(bytes);
        }
    }

    @Override
    public void close() {
        server.stop(0);
    }
}
