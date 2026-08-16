// Server-owned authorization policy for CRM intents.
//
// A provider's needs_confirmation flag is advisory for read-only requests, but
// it can never waive review for a mutating command. Treat unknown intents as
// mutating too, so adding a command without updating this policy fails closed.
const READ_ONLY_INTENTS = new Set(["crm.search"]);

export function isMutatingIntent(intent) {
  return !READ_ONLY_INTENTS.has(intent);
}

export function requiresReview({ intent, needs_confirmation: providerNeedsConfirmation }) {
  return isMutatingIntent(intent) || providerNeedsConfirmation === true;
}

/**
 * Return the canonical understanding used by checkpointing, review creation,
 * and the HTTP response. The model cannot turn off review for mutations.
 */
export function normalizeUnderstanding(providerUnderstanding) {
  if (!providerUnderstanding || typeof providerUnderstanding !== "object") {
    throw new TypeError("provider understanding must be an object");
  }
  return {
    ...providerUnderstanding,
    needs_confirmation: requiresReview(providerUnderstanding),
  };
}
