import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createAuthenticator } from "../src/auth.mjs";

const issuer = "https://issuer.example.test";
const audience = "sumi-voice-crm";
let jwksServer;
let jwksUri;
let privateKey;

test.before(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const publicJwk = await exportJWK(pair.publicKey);
  jwksServer = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        keys: [{ ...publicJwk, alg: "RS256", kid: "auth-test", use: "sig" }],
      }),
    );
  });
  await new Promise((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
  jwksUri = `http://127.0.0.1:${jwksServer.address().port}/jwks.json`;
});

test.after(() => jwksServer?.close());

async function token(overrides = {}, signingKey = privateKey) {
  return await new SignJWT({
    tenant_id: "tenant-a",
    scope: "voice-crm.write",
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "auth-test" })
    .setSubject("actor-a")
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(signingKey);
}

function authenticator(overrides = {}) {
  return createAuthenticator({
    env: {
      APP_ENV: "test",
      AUTH_MODE: "oidc",
      OIDC_ISSUER: issuer,
      OIDC_AUDIENCE: audience,
      OIDC_JWKS_URI: jwksUri,
      OIDC_ALLOW_INSECURE_JWKS: "true",
      OIDC_REQUIRED_SCOPE: "voice-crm.write",
      ...overrides,
    },
  });
}

test("OIDC authentication verifies signature, claims, tenant and scope", async () => {
  const identity = await authenticator()(
    new Headers({
      authorization: `Bearer ${await token()}`,
      "x-tenant-id": "tenant-a",
    }),
  );
  assert.deepEqual(identity, {
    tenant_id: "tenant-a",
    actor_id: "actor-a",
    auth_mode: "oidc",
    principal_kind: "human",
    token_scopes: ["voice-crm.write"],
    authentication_methods: [],
    token_id: undefined,
    algorithm: "RS256",
  });
});

test("OIDC authentication rejects forged, mismatched and underscoped tokens", async () => {
  const authenticate = authenticator();
  const attacker = await generateKeyPair("RS256");
  await assert.rejects(
    authenticate(
      new Headers({
        authorization: `Bearer ${await token({}, attacker.privateKey)}`,
        "x-tenant-id": "tenant-a",
      }),
    ),
    (error) => error.code === "UNAUTHORIZED",
  );
  await assert.rejects(
    authenticate(
      new Headers({
        authorization: `Bearer ${await token()}`,
        "x-tenant-id": "tenant-b",
      }),
    ),
    (error) => error.code === "FORBIDDEN",
  );
  await assert.rejects(
    authenticate(
      new Headers({
        authorization: `Bearer ${await token({ scope: "voice-crm.read" })}`,
        "x-tenant-id": "tenant-a",
      }),
    ),
    (error) => error.code === "FORBIDDEN",
  );
  await assert.rejects(
    authenticate(
      new Headers({
        authorization: "Bearer opaque",
        "x-tenant-id": "tenant-a",
      }),
    ),
    (error) => error.code === "UNAUTHORIZED",
  );
});

test("static authentication binds one bearer token to configured tenant and subject", async () => {
  const authenticate = createAuthenticator({
    env: {
      APP_ENV: "production",
      AUTH_MODE: "static",
      AUTH_STATIC_BEARER_TOKEN: "a".repeat(48),
      AUTH_STATIC_TENANT_ID: "00000000-0000-4000-8000-000000000001",
      AUTH_STATIC_SUBJECT: "sumi-static-operator",
    },
  });
  const expected = {
    tenant_id: "00000000-0000-4000-8000-000000000001",
    actor_id: "sumi-static-operator",
    auth_mode: "static",
    principal_kind: "human",
    status: "active",
    roles: ["tenant_admin"],
    actor_scopes: [
      "interaction.ask",
      "crm.*",
      "review.decide",
      "media.*",
      "events.read",
      "progress.subscribe",
    ],
    token_scopes: [
      "interaction.ask",
      "crm.*",
      "review.decide",
      "media.*",
      "events.read",
      "progress.subscribe",
    ],
    authentication_methods: ["static_token"],
  };
  assert.deepEqual(
    await authenticate(
      new Headers({ authorization: `Bearer ${"a".repeat(48)}` }),
    ),
    expected,
  );
  assert.deepEqual(
    await authenticate(
      new Headers({
        authorization: `Bearer ${"a".repeat(48)}`,
        "x-tenant-id": expected.tenant_id,
      }),
    ),
    expected,
  );
  await assert.rejects(
    authenticate(new Headers({ authorization: `Bearer ${"b".repeat(48)}` })),
    (error) => error.code === "UNAUTHORIZED",
  );
  await assert.rejects(
    authenticate(
      new Headers({
        authorization: `Bearer ${"a".repeat(48)}`,
        "x-tenant-id": "tenant-other",
      }),
    ),
    (error) => error.code === "FORBIDDEN",
  );
});

test("production authentication fails closed on unsafe or incomplete configuration", () => {
  assert.throws(
    () =>
      createAuthenticator({
        env: { APP_ENV: "production", AUTH_MODE: "development" },
      }),
    /forbidden/,
  );
  assert.throws(
    () =>
      createAuthenticator({
        env: {
          APP_ENV: "production",
          AUTH_MODE: "oidc",
          OIDC_ISSUER: issuer,
          OIDC_AUDIENCE: audience,
          OIDC_JWKS_URI: "http://issuer.test/jwks",
        },
      }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      createAuthenticator({
        env: { APP_ENV: "production", AUTH_MODE: "oidc" },
      }),
    /required/,
  );
  assert.throws(
    () =>
      createAuthenticator({
        env: { APP_ENV: "production", AUTH_MODE: "static" },
      }),
    /AUTH_STATIC/,
  );
  assert.throws(
    () =>
      createAuthenticator({
        env: {
          APP_ENV: "production",
          AUTH_MODE: "static",
          AUTH_STATIC_BEARER_TOKEN: "short",
          AUTH_STATIC_TENANT_ID: "tenant-a",
          AUTH_STATIC_SUBJECT: "operator",
        },
      }),
    /32/,
  );
});
