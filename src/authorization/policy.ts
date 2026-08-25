import type {
  Action,
  ActionGrant,
  AuthorizationContext,
  AuthorizationDecision,
  AuthorizationPolicy,
  AuthorizationReasonCode,
  AuthorizationRequest,
  AuthorizationResource,
  ConditionName,
  Obligation,
  Principal,
} from "./types.ts";

type UnknownRecord = Record<string, unknown>;
type ConditionResult = "pass" | "deny" | "missing";

const REQUEST_FIELDS = new Set(["action", "principal", "resource", "context"]);
const PRINCIPAL_FIELDS = new Set([
  "subject_id",
  "kind",
  "tenant_id",
  "status",
  "roles",
  "actor_scopes",
  "workload_id",
]);
const RESOURCE_FIELDS = new Set(["type", "id", "tenant_id", "owner_id"]);
const CONTEXT_FIELDS = new Set([
  "token_scopes",
  "authentication_methods",
  "network_zone",
  "request_id",
]);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyFields(
  value: UnknownRecord,
  fields: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((field) => fields.has(field));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function missingRequiredInput(request: UnknownRecord): boolean {
  if (
    !("action" in request) ||
    !("principal" in request) ||
    !("resource" in request) ||
    !("context" in request)
  )
    return true;
  if (
    !isRecord(request.principal) ||
    !isRecord(request.resource) ||
    !isRecord(request.context)
  )
    return false;
  const principal = request.principal;
  const resource = request.resource;
  const context = request.context;
  return (
    ![
      "subject_id",
      "kind",
      "tenant_id",
      "status",
      "roles",
      "actor_scopes",
    ].every((field) => field in principal) ||
    !["type", "id", "tenant_id"].every((field) => field in resource) ||
    !("token_scopes" in context)
  );
}

function validPrincipal(
  value: UnknownRecord,
): value is UnknownRecord & Principal {
  return (
    isNonEmptyString(value.subject_id) &&
    ["human", "agent", "workload"].includes(String(value.kind)) &&
    isNonEmptyString(value.tenant_id) &&
    ["active", "suspended"].includes(String(value.status)) &&
    isStringArray(value.roles) &&
    isStringArray(value.actor_scopes) &&
    (value.workload_id === undefined || isNonEmptyString(value.workload_id))
  );
}

function validResource(
  value: UnknownRecord,
): value is UnknownRecord & AuthorizationResource {
  return (
    isNonEmptyString(value.type) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.tenant_id) &&
    (value.owner_id === undefined || isNonEmptyString(value.owner_id))
  );
}

function validContext(
  value: UnknownRecord,
): value is UnknownRecord & AuthorizationContext {
  return (
    isStringArray(value.token_scopes) &&
    (value.authentication_methods === undefined ||
      isStringArray(value.authentication_methods)) &&
    (value.network_zone === undefined ||
      ["public", "private", "service"].includes(String(value.network_zone))) &&
    (value.request_id === undefined || isNonEmptyString(value.request_id))
  );
}

function deny(
  policy: AuthorizationPolicy,
  reasonCodes: readonly AuthorizationReasonCode[],
): AuthorizationDecision {
  const reasons: readonly AuthorizationReasonCode[] = Object.freeze([
    ...new Set<AuthorizationReasonCode>(
      reasonCodes.length > 0 ? reasonCodes : ["DEFAULT_DENY"],
    ),
  ]);
  const obligations: readonly Obligation[] = Object.freeze([
    ...(Array.isArray(policy?.deny_obligations) ? policy.deny_obligations : []),
  ]);
  const decision: AuthorizationDecision = Object.freeze({
    effect: "deny",
    policy_version: isNonEmptyString(policy?.policy_version)
      ? policy.policy_version
      : "unknown",
    reason_codes: reasons,
    obligations,
  });
  return decision;
}

function grantMatches(
  grant: string,
  action: Action,
  allowedWildcards: ReadonlySet<string>,
): boolean {
  if (grant === action) return true;
  if (!allowedWildcards.has(grant) || !grant.endsWith(".*")) return false;
  return action.startsWith(grant.slice(0, -1));
}

function scopeIsKnown(scope: string, policy: AuthorizationPolicy): boolean {
  return (
    policy.actions.includes(scope as Action) ||
    policy.allowed_action_wildcards.includes(
      scope as ActionGrant & `${string}.*`,
    )
  );
}

const CONDITIONS: Readonly<
  Record<
    ConditionName,
    (
      policy: AuthorizationPolicy,
      request: AuthorizationRequest,
    ) => ConditionResult
  >
> = Object.freeze({
  tenant_match(_policy, request) {
    if (
      !isNonEmptyString(request.principal.tenant_id) ||
      !isNonEmptyString(request.resource.tenant_id)
    )
      return "missing";
    return request.principal.tenant_id === request.resource.tenant_id
      ? "pass"
      : "deny";
  },
  resource_type_allowed(policy, request) {
    const allowed = policy.action_resources[request.action];
    if (!Array.isArray(allowed) || !isNonEmptyString(request.resource.type))
      return "missing";
    return allowed.includes(request.resource.type) ? "pass" : "deny";
  },
  active_principal(_policy, request) {
    if (!isNonEmptyString(request.principal.status)) return "missing";
    return request.principal.status === "active" ? "pass" : "deny";
  },
  human_principal(_policy, request) {
    if (!isNonEmptyString(request.principal.kind)) return "missing";
    return request.principal.kind === "human" ? "pass" : "deny";
  },
  mfa_present(_policy, request) {
    if (!Array.isArray(request.context.authentication_methods))
      return "missing";
    return request.context.authentication_methods.includes("mfa")
      ? "pass"
      : "deny";
  },
  workload_principal(_policy, request) {
    if (
      !isNonEmptyString(request.principal.kind) ||
      !isNonEmptyString(request.principal.workload_id)
    )
      return "missing";
    return request.principal.kind === "workload" ? "pass" : "deny";
  },
  trusted_network(_policy, request) {
    if (!isNonEmptyString(request.context.network_zone)) return "missing";
    return request.context.network_zone === "private" ||
      request.context.network_zone === "service"
      ? "pass"
      : "deny";
  },
});

/**
 * Evaluates a closed RBAC upper bound, intersects it with actor and token
 * capabilities, then applies named ABAC conditions. The function is total:
 * malformed or unknown input becomes a deterministic denial.
 */
export function evaluateAuthorization(
  policy: AuthorizationPolicy,
  input: unknown,
): AuthorizationDecision {
  if (!isRecord(input)) return deny(policy, ["MISSING_ATTRIBUTE"]);
  if (!hasOnlyFields(input, REQUEST_FIELDS))
    return deny(policy, ["UNKNOWN_FIELD"]);
  if (missingRequiredInput(input)) return deny(policy, ["MISSING_ATTRIBUTE"]);
  if (
    !isRecord(input.principal) ||
    !isRecord(input.resource) ||
    !isRecord(input.context)
  ) {
    return deny(policy, ["INVALID_ATTRIBUTE"]);
  }
  if (
    !hasOnlyFields(input.principal, PRINCIPAL_FIELDS) ||
    !hasOnlyFields(input.resource, RESOURCE_FIELDS) ||
    !hasOnlyFields(input.context, CONTEXT_FIELDS)
  ) {
    return deny(policy, ["UNKNOWN_FIELD"]);
  }
  if (
    !validPrincipal(input.principal) ||
    !validResource(input.resource) ||
    !validContext(input.context)
  ) {
    return deny(policy, ["INVALID_ATTRIBUTE"]);
  }
  if (
    !isNonEmptyString(input.action) ||
    !policy.actions.includes(input.action as Action)
  ) {
    return deny(policy, ["UNKNOWN_ACTION"]);
  }

  const request = input as unknown as AuthorizationRequest;
  if (request.principal.roles.some((role) => !policy.roles.includes(role))) {
    return deny(policy, ["UNKNOWN_ROLE"]);
  }
  if (
    [...request.principal.actor_scopes, ...request.context.token_scopes].some(
      (scope) => !scopeIsKnown(scope, policy),
    )
  ) {
    return deny(policy, ["UNKNOWN_SCOPE"]);
  }

  const wildcards = new Set<string>(policy.allowed_action_wildcards);
  const reasons: AuthorizationReasonCode[] = [];
  const roleAllows = request.principal.roles.some((role) =>
    policy.role_actions[role]?.some((grant) =>
      grantMatches(grant, request.action, wildcards),
    ),
  );
  if (!roleAllows) reasons.push("RBAC_DENY");
  if (
    !request.principal.actor_scopes.some((scope) =>
      grantMatches(scope, request.action, wildcards),
    )
  ) {
    reasons.push("ACTOR_SCOPE_DENY");
  }
  if (
    !request.context.token_scopes.some((scope) =>
      grantMatches(scope, request.action, wildcards),
    )
  ) {
    reasons.push("TOKEN_SCOPE_DENY");
  }

  const conditions: unknown = policy.action_conditions[request.action];
  if (!Array.isArray(conditions)) return deny(policy, ["UNKNOWN_ACTION"]);
  for (const rawName of conditions) {
    if (typeof rawName !== "string" || !Object.hasOwn(CONDITIONS, rawName)) {
      reasons.push("UNKNOWN_CONDITION");
      continue;
    }
    const name = rawName as ConditionName;
    const condition = CONDITIONS[name];
    if (!condition || !policy.conditions.includes(name)) {
      reasons.push("UNKNOWN_CONDITION");
      continue;
    }
    const result = condition(policy, request);
    if (result === "missing") reasons.push("MISSING_ATTRIBUTE");
    else if (result === "deny") reasons.push("CONDITION_DENY");
  }

  if (reasons.length > 0) return deny(policy, reasons);
  const decision: AuthorizationDecision = Object.freeze({
    effect: "allow",
    policy_version: policy.policy_version,
    reason_codes: Object.freeze(["ALLOW"] as const),
    obligations: Object.freeze([...policy.allow_obligations[request.action]]),
  });
  return decision;
}
