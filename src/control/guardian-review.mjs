import { runWithStagedTimeout } from "../lifecycle/staged-timeout.mjs";
import { createGuardianDenialGovernor } from "./guardian-denial-governor.mjs";

export const DEFAULT_GUARDIAN_REVIEW_TIMEOUT_MS = 90_000;

function positiveInteger(value, fallback, name) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new TypeError(`${name} must be a positive integer`);
  return parsed;
}

/**
 * Coordinates an external permission reviewer without granting authority.
 * Unavailability and malformed output always become human review.
 */
export class GuardianReviewCoordinator {
  constructor({
    evaluate,
    governor = createGuardianDenialGovernor(),
    reviewTimeoutMs = DEFAULT_GUARDIAN_REVIEW_TIMEOUT_MS,
    hardGraceMs = 2_000,
    terminate,
  } = {}) {
    if (typeof evaluate !== "function") throw new TypeError("Guardian evaluate must be a function");
    if (terminate !== undefined && typeof terminate !== "function") throw new TypeError("Guardian terminate must be a function");
    this.evaluate = evaluate;
    this.governor = governor;
    this.reviewTimeoutMs = positiveInteger(reviewTimeoutMs, DEFAULT_GUARDIAN_REVIEW_TIMEOUT_MS, "reviewTimeoutMs");
    this.hardGraceMs = positiveInteger(hardGraceMs, 2_000, "hardGraceMs");
    this.terminate = terminate;
  }

  async review({ turn_id, policy = "standard", request, signal } = {}) {
    try {
      const decision = await runWithStagedTimeout(
        (operationSignal) => this.evaluate(Object.freeze({ request, signal: operationSignal })),
        {
          signal,
          softTimeoutMs: this.reviewTimeoutMs,
          hardGraceMs: this.hardGraceMs,
          label: "Guardian review",
          onHardTimeout: this.terminate,
        },
      );
      if (!decision || !new Set(["allow", "reject"]).has(decision.decision)) {
        return Object.freeze({ kind: "human_review_required", reason: "guardian_malformed" });
      }
      const action = decision.decision === "reject"
        ? this.governor.recordDenial(turn_id, policy)
        : this.governor.recordNonDenial(turn_id, policy);
      if (action.kind === "interrupt_turn") {
        return Object.freeze({ kind: "interrupt_turn", decision: decision.decision, action });
      }
      return Object.freeze({ kind: decision.decision, action });
    } catch (error) {
      if (signal?.aborted) throw error;
      return Object.freeze({
        kind: "human_review_required",
        reason: error?.phase ? "guardian_timeout" : "guardian_unavailable",
      });
    }
  }
}

export function createGuardianReviewCoordinator(options) {
  return new GuardianReviewCoordinator(options);
}
