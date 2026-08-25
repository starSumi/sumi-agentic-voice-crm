type DecisionLike = {
  readonly policy_version?: unknown;
  readonly reason_codes?: unknown;
};

export type AuthorizationErrorDetails = Readonly<{
  policy_version: string;
  reason_codes: readonly string[];
}>;

function decisionLike(value: unknown): DecisionLike {
  return value && typeof value === "object" ? value : {};
}

export function authorizationDetails(
  input: unknown,
  fallbackPolicyVersion = "unknown",
): AuthorizationErrorDetails {
  const decision = decisionLike(input);
  const policyVersion =
    typeof decision.policy_version === "string" &&
    decision.policy_version.length > 0
      ? decision.policy_version
      : fallbackPolicyVersion;
  const reasonCodes = Array.isArray(decision.reason_codes)
    ? [
        ...new Set(
          decision.reason_codes.filter(
            (reason): reason is string =>
              typeof reason === "string" && reason.length > 0,
          ),
        ),
      ]
    : [];
  return Object.freeze({
    policy_version: policyVersion,
    reason_codes: Object.freeze(
      reasonCodes.length > 0 ? reasonCodes : ["DEFAULT_DENY"],
    ),
  });
}

export function authorizationError(
  decision?: unknown,
  fallbackPolicyVersion = "unknown",
): Error & { code: "FORBIDDEN"; details: AuthorizationErrorDetails } {
  return Object.assign(new Error("operation is not authorized"), {
    code: "FORBIDDEN" as const,
    details: authorizationDetails(decision, fallbackPolicyVersion),
  });
}

export function unsatisfiedAuthorizationObligation(
  decision?: unknown,
): Error & { code: "FORBIDDEN"; details: AuthorizationErrorDetails } {
  const source = decisionLike(decision);
  return authorizationError({
    policy_version: source.policy_version,
    reason_codes: ["OBLIGATION_UNSATISFIED"],
  });
}
