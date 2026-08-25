export type AuthorizationEffect = "allow" | "deny";

export type PrincipalKind = "human" | "agent" | "workload";

export type Role =
  "agent" | "reviewer" | "auditor" | "tenant_admin" | "workload";

export type Action =
  | "interaction.ask"
  | "crm.search"
  | "crm.customer.create"
  | "crm.deal.update_stage"
  | "review.decide"
  | "media.tts.create"
  | "media.asset.read"
  | "events.read"
  | "progress.subscribe"
  | "outbox.relay";

export type ActionWildcard = "crm.*" | "media.*";
export type ActionGrant = Action | ActionWildcard;

export type ResourceType =
  | "interaction"
  | "customer"
  | "deal"
  | "review"
  | "media_asset"
  | "event_stream"
  | "progress_stream"
  | "outbox";

export type ConditionName =
  | "tenant_match"
  | "resource_type_allowed"
  | "active_principal"
  | "human_principal"
  | "mfa_present"
  | "workload_principal"
  | "trusted_network";

export type Obligation =
  | "audit_log"
  | "tenant_filter"
  | "idempotency_key"
  | "human_review"
  | "outbox_write"
  | "encrypted_asset"
  | "no_store"
  | "subject_filter";

export type AuthorizationReasonCode =
  | "ALLOW"
  | "DEFAULT_DENY"
  | "UNKNOWN_FIELD"
  | "MISSING_ATTRIBUTE"
  | "INVALID_ATTRIBUTE"
  | "UNKNOWN_ACTION"
  | "UNKNOWN_ROLE"
  | "UNKNOWN_SCOPE"
  | "UNKNOWN_CONDITION"
  | "RBAC_DENY"
  | "ACTOR_SCOPE_DENY"
  | "TOKEN_SCOPE_DENY"
  | "CONDITION_DENY"
  | "OBLIGATION_UNSATISFIED";

export interface Principal {
  readonly subject_id: string;
  readonly kind: PrincipalKind;
  readonly tenant_id: string;
  readonly status: "active" | "suspended";
  readonly roles: readonly Role[];
  readonly actor_scopes: readonly ActionGrant[];
  readonly workload_id?: string;
}

export interface AuthorizationResource {
  readonly type: ResourceType;
  readonly id: string;
  readonly tenant_id: string;
  readonly owner_id?: string;
}

export interface AuthorizationContext {
  readonly token_scopes: readonly ActionGrant[];
  readonly authentication_methods?: readonly string[];
  readonly network_zone?: "public" | "private" | "service";
  readonly request_id?: string;
}

export interface AuthorizationRequest {
  readonly action: Action;
  readonly principal: Principal;
  readonly resource: AuthorizationResource;
  readonly context: AuthorizationContext;
}

export interface AuthorizationDecision {
  readonly effect: AuthorizationEffect;
  readonly policy_version: string;
  readonly reason_codes: readonly AuthorizationReasonCode[];
  readonly obligations: readonly Obligation[];
}

export interface AuthorizationPolicy {
  readonly schema_version: "sumi.authorization-policy.v1";
  readonly policy_version: string;
  readonly default_effect: "deny";
  readonly roles: readonly Role[];
  readonly actions: readonly Action[];
  readonly resource_types: readonly ResourceType[];
  readonly conditions: readonly ConditionName[];
  readonly allowed_action_wildcards: readonly ActionWildcard[];
  readonly role_actions: Readonly<Record<Role, readonly ActionGrant[]>>;
  readonly action_resources: Readonly<Record<Action, readonly ResourceType[]>>;
  readonly action_conditions: Readonly<
    Record<Action, readonly ConditionName[]>
  >;
  readonly allow_obligations: Readonly<Record<Action, readonly Obligation[]>>;
  readonly deny_obligations: readonly Obligation[];
}
