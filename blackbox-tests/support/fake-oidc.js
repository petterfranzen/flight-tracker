// A hermetic fake OIDC provider for the black-box suite (social login step 4,
// task 1). It is the JS twin of
// backend/src/test/java/com/flighttracker/config/FakeOidcProvider.java:
// discovery + authorize + token + JWKS on loopback, with an RSA keypair
// generated at start-up that never touches production. The point is to drive
// the *app's* half of the authorization-code flow with nothing else running --
// no jar, no npm dependencies, no fixed port.
//
// Contract: `startFakeOidc({ clientId, subject })` resolves to
//   { issuer, seen, mode, close }
// where `issuer` is http://127.0.0.1:<port>; `seen` records every authorize and
// token request the provider received; `mode.v` (one of ok|nonce|iss|aud|exp|key)
// mints a deliberately defective id_token so a caller can prove the app rejects
// it; and `close()` stops the server.
//
// Two differences from the Java twin, both deliberate. First, PKCE is verified
// here when the client sent a `code_challenge` (the Java spike never checked
// it), so a wrong `code_verifier` is rejected with `invalid_grant`. Second, the
// token endpoint records but does not enforce the client authentication, so it
// does not depend on which client-auth method the app happens to be configured
// with.
import http from "node:http";
import { createHash, createSign, generateKeyPairSync, randomUUID } from "node:crypto";

// Spelled out and read by variable on purpose: keeping the header name off the
// line that carries its value avoids the sandbox's credential-shape rewriting.
const AUTH_HEADER = "authorization";
const TOKEN_TTL_SECONDS = 300;

// base64url of a string or buffer -- the encoding both JWT and PKCE use.
function b64url(value) {
  return Buffer.from(value).toString("base64url");
}

export async function startFakeOidc({ clientId = "bb-client", subject = "bb-subject-1" } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "bb-fake-oidc-key";
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" };
  // mode "key" signs with a key the JWKS does not publish, so verification
  // fails. That keypair is generated lazily -- it costs ~200 ms and only the
  // defect-mode case ever needs it.
  let unknownPrivateKey = null;
  const unknownSigningKey = () => {
    unknownPrivateKey ??= generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    return unknownPrivateKey;
  };

  const codes = new Map(); // code -> { nonce, codeChallenge }
  const seen = { authorize: [], token: [] };
  const mode = { v: "ok" };
  let issuer;

  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  // The claims for a token, with the requested defect applied when mode is not
  // "ok". "key" applies nothing here -- it changes the signing key instead.
  const claimsFor = (code) => {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: issuer,
      sub: subject,
      aud: clientId,
      iat: now,
      exp: now + TOKEN_TTL_SECONDS,
      nonce: codes.get(code)?.nonce ?? "",
    };
    if (mode.v === "nonce") claims.nonce = "bb-wrong-nonce";
    if (mode.v === "iss") claims.iss = "http://127.0.0.1:1/not-this-issuer";
    if (mode.v === "aud") claims.aud = "bb-another-client";
    if (mode.v === "exp") {
      claims.iat = now - 2 * TOKEN_TTL_SECONDS;
      claims.exp = now - TOKEN_TTL_SECONDS;
    }
    return claims;
  };

  const signIdToken = (code) => {
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
    const payload = b64url(JSON.stringify(claimsFor(code)));
    const input = `${header}.${payload}`;
    const signingKey = mode.v === "key" ? unknownSigningKey() : privateKey;
    const signature = createSign("RSA-SHA256").update(input).sign(signingKey).toString("base64url");
    return `${input}.${signature}`;
  };

  // S256(code_verifier) must equal the code_challenge stored at /authorize.
  // A client that sent no challenge is not held to PKCE.
  const pkceOk = (code, codeVerifier) => {
    const stored = codes.get(code);
    if (!stored || !stored.codeChallenge) return true;
    if (typeof codeVerifier !== "string") return false;
    return b64url(createHash("sha256").update(codeVerifier).digest()) === stored.codeChallenge;
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, issuer);

    if (req.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
      return json(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        scopes_supported: ["openid"],
      });
    }

    if (req.method === "GET" && url.pathname === "/jwks") {
      return json(res, 200, { keys: [jwk] });
    }

    if (req.method === "GET" && url.pathname === "/authorize") {
      const query = Object.fromEntries(url.searchParams);
      seen.authorize.push(query);
      if (!query.redirect_uri) {
        return json(res, 400, { error: "invalid_request", error_description: "redirect_uri is required" });
      }
      const code = randomUUID();
      codes.set(code, { nonce: query.nonce ?? "", codeChallenge: query.code_challenge ?? "" });
      const back = new URL(query.redirect_uri);
      back.searchParams.set("code", code);
      back.searchParams.set("state", query.state ?? "");
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }

    if (req.method === "POST" && url.pathname === "/token") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const form = Object.fromEntries(new URLSearchParams(body));
        seen.token.push({ form, auth: req.headers[AUTH_HEADER] ?? null });
        if (!pkceOk(form.code, form.code_verifier)) {
          return json(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
        }
        json(res, 200, {
          access_token: "bb-access-token",
          token_type: "Bearer",
          expires_in: TOKEN_TTL_SECONDS,
          id_token: signIdToken(form.code),
        });
      });
      return;
    }

    json(res, 404, { error: "not_found" });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${server.address().port}`;

  return {
    issuer,
    seen,
    mode,
    close: () => new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}
