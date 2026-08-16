const READ_ONLY_INTENTS = new Set(["crm.search"]);

export function isMutatingIntent(intent) {
  return !READ_ONLY_INTENTS.has(intent);
}

export function requiresReview({ intent, needs_confirmation: providerNeedsConfirmation }) {
  return isMutatingIntent(intent) || providerNeedsConfirmation === true;
}

export function normalizeUnderstanding(providerUnderstanding) {
  if (!providerUnderstanding || typeof providerUnderstanding !== "object") {
    throw new TypeError("provider understanding must be an object");
  }
  return {
    ...providerUnderstanding,
    needs_confirmation: requiresReview(providerUnderstanding),
  };
}
