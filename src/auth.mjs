import { createHash, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";

const SAFE_TENANT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_SUBJECT = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,254}$/;
const DEFAULT_ALGORITHMS = ["RS256", "ES256"];

function authError(message, code = "UNAUTHORIZED", cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function bearerToken(headers) {
  const authorization = headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) throw authError("authentication required");
  const token = authorization.slice(7).trim();
  if (!token || token.length > 8192 || /[\r\n]/.test(token)) throw authError("invalid bearer token");
  return token;
}

function requestedTenant(headers) {
  const tenantId = headers.get("x-tenant-id")?.trim();
  if (!tenantId) throw authError("X-Tenant-Id is required", "INVALID_REQUEST");
  if (!SAFE_TENANT.test(tenantId)) throw authError("X-Tenant-Id has an invalid format", "INVALID_REQUEST");
  return tenantId;
}

function configuredStaticIdentity(env) {
  const token = env.AUTH_STATIC_BEARER_TOKEN?.trim();
  const tenantId = env.AUTH_STATIC_TENANT_ID?.trim();
  const subject = env.AUTH_STATIC_SUBJECT?.trim();
  if (!token || !tenantId || !subject) {
    throw new Error("AUTH_STATIC_BEARER_TOKEN, AUTH_STATIC_TENANT_ID and AUTH_STATIC_SUBJECT are required in static mode");
  }
  if (token.length < 32 || token.length > 8192 || /[\r\n]/.test(token)) {
    throw new Error("AUTH_STATIC_BEARER_TOKEN must contain between 32 and 8192 characters without newlines");
  }
  if (!SAFE_TENANT.test(tenantId)) throw new Error("AUTH_STATIC_TENANT_ID has an invalid format");
  if (!SAFE_SUBJECT.test(subject)) throw new Error("AUTH_STATIC_SUBJECT has an invalid format");
  return { token, tenantId, subject };
}

function tokenDigest(value) {
  return createHash("sha256").update(value, "utf8").digest();
}

function tenantClaim(payload, claimName) {
  return payload[claimName] ?? payload.tenant_id ?? payload.tid ?? payload["https://sumi.invalid/tenant_id"];
}

function scopes(payload) {
  if (Array.isArray(payload.scp)) return payload.scp;
  const raw = payload.scope ?? payload.scp ?? "";
  return typeof raw === "string" ? raw.split(/\s+/).filter(Boolean) : [];
}

export function createAuthenticator({ env = process.env, remoteJwks, verify = jwtVerify } = {}) {
  const mode = env.AUTH_MODE || (env.APP_ENV === "production" ? "oidc" : "development");
  if (mode === "development") {
    if (env.APP_ENV === "production") throw new Error("AUTH_MODE=development is forbidden when APP_ENV=production");
    return async (headers) => {
      const token = bearerToken(headers);
      return { tenant_id: requestedTenant(headers), actor_id: token.slice(0, 80), auth_mode: mode };
    };
  }
  if (mode === "static") {
    const identity = configuredStaticIdentity(env);
    const expectedDigest = tokenDigest(identity.token);
    return async (headers) => {
      const suppliedDigest = tokenDigest(bearerToken(headers));
      if (!timingSafeEqual(suppliedDigest, expectedDigest)) throw authError("bearer token verification failed");
      const tenantHeader = headers.get("x-tenant-id")?.trim();
      if (tenantHeader && tenantHeader !== identity.tenantId) {
        throw authError("token is not bound to this tenant", "FORBIDDEN");
      }
      return { tenant_id: identity.tenantId, actor_id: identity.subject, auth_mode: mode };
    };
  }
  if (mode !== "oidc") throw new Error(`unsupported AUTH_MODE: ${mode}`);

  const issuer = env.OIDC_ISSUER;
  const audience = env.OIDC_AUDIENCE;
  const jwksUri = env.OIDC_JWKS_URI;
  if (!issuer || !audience || !jwksUri) throw new Error("OIDC_ISSUER, OIDC_AUDIENCE and OIDC_JWKS_URI are required in OIDC mode");
  const jwksUrl = new URL(jwksUri);
  if (jwksUrl.protocol !== "https:" && !(env.APP_ENV !== "production" && env.OIDC_ALLOW_INSECURE_JWKS === "true")) {
    throw new Error("OIDC_JWKS_URI must use HTTPS");
  }
  const algorithms = (env.OIDC_ALLOWED_ALGORITHMS || DEFAULT_ALGORITHMS.join(","))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!algorithms.length || algorithms.some((algorithm) => !DEFAULT_ALGORITHMS.includes(algorithm))) {
    throw new Error(`OIDC_ALLOWED_ALGORITHMS must be a subset of ${DEFAULT_ALGORITHMS.join(",")}`);
  }
  const keySet = remoteJwks ?? createRemoteJWKSet(jwksUrl, {
    timeoutDuration: Number(env.OIDC_JWKS_TIMEOUT_MS || 5000),
    cooldownDuration: Number(env.OIDC_JWKS_COOLDOWN_MS || 30_000),
    cacheMaxAge: Number(env.OIDC_JWKS_CACHE_MAX_AGE_MS || 600_000),
  });
  const requiredScope = env.OIDC_REQUIRED_SCOPE?.trim();
  const claimName = env.OIDC_TENANT_CLAIM?.trim() || "tenant_id";

  return async (headers) => {
    const token = bearerToken(headers);
    const tenantId = requestedTenant(headers);
    try {
      const { payload, protectedHeader } = await verify(token, keySet, { issuer, audience, algorithms });
      if (!payload.sub || typeof payload.sub !== "string") throw authError("token subject is required");
      const boundTenant = tenantClaim(payload, claimName);
      if (!boundTenant || boundTenant !== tenantId) throw authError("token is not bound to this tenant", "FORBIDDEN");
      if (requiredScope && !scopes(payload).includes(requiredScope)) throw authError("token does not grant the required scope", "FORBIDDEN");
      return {
        tenant_id: tenantId,
        actor_id: payload.sub,
        auth_mode: mode,
        token_id: typeof payload.jti === "string" ? payload.jti : undefined,
        algorithm: protectedHeader.alg,
      };
    } catch (error) {
      if (error?.code === "FORBIDDEN" || error?.code === "INVALID_REQUEST") throw error;
      throw authError("bearer token verification failed", "UNAUTHORIZED", error);
    }
  };
}
