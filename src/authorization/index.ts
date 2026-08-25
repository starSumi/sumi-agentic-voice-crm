export { evaluateAuthorization } from "./policy.ts";
export {
  authorizationDetails,
  authorizationError,
  unsatisfiedAuthorizationObligation,
} from "./errors.ts";
export type { AuthorizationErrorDetails } from "./errors.ts";
export type {
  Action,
  ActionGrant,
  ActionWildcard,
  AuthorizationContext,
  AuthorizationDecision,
  AuthorizationEffect,
  AuthorizationPolicy,
  AuthorizationReasonCode,
  AuthorizationRequest,
  AuthorizationResource,
  ConditionName,
  Obligation,
  Principal,
  PrincipalKind,
  ResourceType,
  Role,
} from "./types.ts";
