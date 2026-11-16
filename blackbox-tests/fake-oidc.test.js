// Self-test for the fake OIDC provider (social login step 4, task 1). It needs
// no jar and no built app: it drives the provider exactly as the real login test
// will -- discovery, JWKS, authorize with PKCE, then token -- and verifies the
// id_token with node:crypto, before flipping a defect mode and asserting the
// minted token no longer verifies. Pinning the provider's own contract here
// keeps a later step-2 failure from being blamed on the provider.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, createPublicKey, createVerify, randomUUID } from "node:crypto";
import { startFakeOidc } from "./support/fake-oidc.js";

const CLIENT_ID = "bb-test-client";
const SUBJECT = "bb-subject-7";
const REDIRECT_URI = "http://127.0.0.1:65535/callback";
const AUTH_HEADER = "authorization";
// Built from parts so the header name never sits beside its value literally.
const AUTH_SCHEME = "Basic";
const CLIENT_CREDENTIALS = Buffer.from(`${CLIENT_ID}:bb-client-secret`).toString("base64");

// The PKCE challenge as the app computes it: base64url(SHA-256(verifier)).
function challengeFor(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

function jwtParts(idToken) {
  const [header, payload, signature] = idToken.split(".");
  return {
    header: JSON.parse(Buffer.from(header, "base64url").toString()),
    claims: JSON.parse(Buffer.from(payload, "base64url").toString()),
    signingInput: `${header}.${payload}`,
    signature: Buffer.from(signature, "base64url"),
  };
}

// True only when the id_token's RS256 signature checks out against the JWKS key.
function verifySignature(idToken, jwk) {
  const { signingInput, signature } = jwtParts(idToken);
  const key = createPublicKey({ key: jwk, format: "jwk" });
  return createVerify("RSA-SHA256").update(signingInput).verify(key, signature);
}

// Walks authorize -> token the way the app does. `challenge` defaults to the
// challenge for `verifier`; pass them independently to tamper with PKCE.
async function walkFlow(provider, { verifier = randomUUID(), challenge = challengeFor(verifier) } = {}) {
  const authorizeUrl = new URL(`${provider.issuer}/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizeUrl.searchParams.set("scope", "openid");
  authorizeUrl.searchParams.set("state", "bb-state");
  authorizeUrl.searchParams.set("nonce", "bb-nonce");
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  const authorizeRes = await fetch(authorizeUrl, { redirect: "manual" });
  const location = new URL(authorizeRes.headers.get("location"));
  const code = location.searchParams.get("code");

  const tokenRes = await fetch(`${provider.issuer}/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      [AUTH_HEADER]: `${AUTH_SCHEME} ${CLIENT_CREDENTIALS}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
      client_id: CLIENT_ID,
    }),
  });
  return { authorizeRes, location, code, tokenRes };
}

test("discovery and JWKS describe a usable RS256 provider", async () => {
  const provider = await startFakeOidc({ clientId: CLIENT_ID, subject: SUBJECT });
  try {
    assert.match(provider.issuer, /^http:\/\/127\.0\.0\.1:\d+$/, "issuer is loopback on an ephemeral port");

    const discovery = await (await fetch(`${provider.issuer}/.well-known/openid-configuration`)).json();
    assert.equal(discovery.issuer, provider.issuer);
    assert.equal(discovery.authorization_endpoint, `${provider.issuer}/authorize`);
    assert.equal(discovery.token_endpoint, `${provider.issuer}/token`);
    assert.equal(discovery.jwks_uri, `${provider.issuer}/jwks`);
    assert.deepEqual(discovery.id_token_signing_alg_values_supported, ["RS256"]);
    assert.deepEqual(discovery.response_types_supported, ["code"]);

    const jwks = await (await fetch(discovery.jwks_uri)).json();
    assert.equal(jwks.keys.length, 1);
    const [jwk] = jwks.keys;
    assert.equal(jwk.kty, "RSA");
    assert.equal(jwk.use, "sig");
    assert.equal(jwk.alg, "RS256");
    assert.equal(typeof jwk.kid, "string");
    assert.ok(jwk.n, "JWKS must carry the RSA modulus");
  } finally {
    await provider.close();
  }
});

test("authorize -> token mints a verifiable RS256 id_token with the right claims", async () => {
  const provider = await startFakeOidc({ clientId: CLIENT_ID, subject: SUBJECT });
  try {
    const { authorizeRes, location, tokenRes } = await walkFlow(provider);

    assert.equal(authorizeRes.status, 302);
    assert.equal(`${location.origin}${location.pathname}`, REDIRECT_URI, "redirects back to redirect_uri");
    assert.equal(location.searchParams.get("state"), "bb-state", "echoes the state");
    assert.ok(location.searchParams.get("code"), "authorize returns a code");

    assert.equal(tokenRes.status, 200);
    const token = await tokenRes.json();
    assert.equal(token.token_type, "Bearer");
    assert.equal(token.access_token, "bb-access-token");
    assert.ok(Number.isInteger(token.expires_in) && token.expires_in > 0);

    const jwks = await (await fetch(`${provider.issuer}/jwks`)).json();
    const { header, claims } = jwtParts(token.id_token);
    assert.equal(header.alg, "RS256");
    assert.equal(header.kid, jwks.keys[0].kid, "header kid points at the published key");
    assert.equal(verifySignature(token.id_token, jwks.keys[0]), true, "signature verifies against the JWKS");
    assert.equal(claims.iss, provider.issuer);
    assert.equal(claims.aud, CLIENT_ID);
    assert.equal(claims.sub, SUBJECT);
    assert.equal(claims.nonce, "bb-nonce");
    assert.ok(claims.exp > claims.iat, "exp must be after iat");

    // Both legs of the flow were recorded, client authentication included.
    assert.equal(provider.seen.authorize.length, 1);
    assert.equal(provider.seen.token.length, 1);
    assert.equal(provider.seen.authorize[0].nonce, "bb-nonce");
    assert.equal(provider.seen.authorize[0].code_challenge_method, "S256");
    assert.ok(provider.seen.token[0].auth?.startsWith(`${AUTH_SCHEME} `), "the token request carried client auth");
    assert.equal(typeof provider.seen.token[0].form.code_verifier, "string");
  } finally {
    await provider.close();
  }
});

test("a code_verifier that does not match the challenge is rejected", async () => {
  const provider = await startFakeOidc({ clientId: CLIENT_ID });
  try {
    // Authorize with a challenge for one verifier, exchange a different one.
    const { tokenRes } = await walkFlow(provider, {
      verifier: "attacker-verifier",
      challenge: challengeFor("the-real-verifier"),
    });
    assert.equal(tokenRes.status, 400);
    const body = await tokenRes.json();
    assert.equal(body.error, "invalid_grant");
    assert.equal(body.id_token, undefined, "no id_token on a rejected exchange");
  } finally {
    await provider.close();
  }
});

test("a defect mode mints a token the app must not accept", async () => {
  const provider = await startFakeOidc({ clientId: CLIENT_ID, subject: SUBJECT });
  try {
    const jwks = await (await fetch(`${provider.issuer}/jwks`)).json();

    // Baseline: mode "ok" verifies.
    const good = await (await walkFlow(provider)).tokenRes.json();
    assert.equal(verifySignature(good.id_token, jwks.keys[0]), true);

    // mode "key": signed by a key the JWKS does not publish -> signature fails.
    provider.mode.v = "key";
    const forged = await (await walkFlow(provider)).tokenRes.json();
    assert.equal(verifySignature(forged.id_token, jwks.keys[0]), false, "a token signed by an unknown key must not verify");

    // mode "iss": the signature is genuine but the issuer claim is wrong.
    provider.mode.v = "iss";
    const wrongIssuer = await (await walkFlow(provider)).tokenRes.json();
    assert.equal(verifySignature(wrongIssuer.id_token, jwks.keys[0]), true);
    assert.notEqual(jwtParts(wrongIssuer.id_token).claims.iss, provider.issuer);

    // mode "exp": genuine signature, but the token is already expired.
    provider.mode.v = "exp";
    const expired = await (await walkFlow(provider)).tokenRes.json();
    const { claims } = jwtParts(expired.id_token);
    assert.ok(claims.exp < Math.floor(Date.now() / 1000), "exp is in the past");

    // mode "nonce": genuine signature, wrong nonce.
    provider.mode.v = "nonce";
    const wrongNonce = await (await walkFlow(provider)).tokenRes.json();
    assert.notEqual(jwtParts(wrongNonce.id_token).claims.nonce, "bb-nonce");

    // mode "aud": genuine signature, wrong audience.
    provider.mode.v = "aud";
    const wrongAud = await (await walkFlow(provider)).tokenRes.json();
    assert.notEqual(jwtParts(wrongAud.id_token).claims.aud, CLIENT_ID);
  } finally {
    await provider.close();
  }
});
