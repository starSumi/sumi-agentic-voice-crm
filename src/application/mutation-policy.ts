import {
  agentCrmIntentDefinition,
  isAgentCrmIntent,
} from "../agent-crm-contract.ts";

export type ProviderUnderstanding = Readonly<Record<string, unknown>> & {
  readonly intent: string;
  readonly needs_confirmation?: boolean;
};

export function isMutatingIntent(intent: string): boolean {
  return !isAgentCrmIntent(intent) || agentCrmIntentDefinition(intent).effect === "write";
}

export function requiresReview({ intent, needs_confirmation: providerNeedsConfirmation }: Pick<ProviderUnderstanding, "intent" | "needs_confirmation">): boolean {
  return isMutatingIntent(intent) || providerNeedsConfirmation === true;
}

export function normalizeUnderstanding(providerUnderstanding: ProviderUnderstanding): ProviderUnderstanding & { readonly needs_confirmation: boolean } {
  if (!providerUnderstanding || typeof providerUnderstanding !== "object") {
    throw new TypeError("provider understanding must be an object");
  }
  return {
    ...providerUnderstanding,
    needs_confirmation: requiresReview(providerUnderstanding),
  };
}
