import { runWithStagedTimeout } from "../lifecycle/staged-timeout.ts";
import { createGuardianDenialGovernor, type GuardianDenialGovernor } from "./guardian-denial-governor.ts";

export const DEFAULT_GUARDIAN_REVIEW_TIMEOUT_MS = 90_000;

type GuardianDecision = { decision: "allow" | "reject" };
type GuardianEvaluate = (input: Readonly<{ request: unknown; signal: AbortSignal }>) => GuardianDecision | PromiseLike<GuardianDecision>;
type GuardianReviewOptions = {
  evaluate: GuardianEvaluate;
  governor?: GuardianDenialGovernor;
  reviewTimeoutMs?: number;
  hardGraceMs?: number;
  terminate?: () => void | PromiseLike<void>;
};

function positiveInteger(value: unknown, fallback: number, name: string): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new TypeError(`${name} must be a positive integer`);
  return parsed;
}

/**
 * Coordinates an external permission reviewer without granting authority.
 * Unavailability and malformed output always become human review.
 */
export class GuardianReviewCoordinator {
  readonly evaluate: GuardianEvaluate;
  readonly governor: GuardianDenialGovernor;
  readonly reviewTimeoutMs: number;
  readonly hardGraceMs: number;
  readonly terminate?: () => void | PromiseLike<void>;

  constructor({
    evaluate,
    governor = createGuardianDenialGovernor(),
    reviewTimeoutMs = DEFAULT_GUARDIAN_REVIEW_TIMEOUT_MS,
    hardGraceMs = 2_000,
    terminate,
  }: Partial<GuardianReviewOptions> = {}) {
    if (typeof evaluate !== "function") throw new TypeError("Guardian evaluate must be a function");
    if (terminate !== undefined && typeof terminate !== "function") throw new TypeError("Guardian terminate must be a function");
    this.evaluate = evaluate;
    this.governor = governor;
    this.reviewTimeoutMs = positiveInteger(reviewTimeoutMs, DEFAULT_GUARDIAN_REVIEW_TIMEOUT_MS, "reviewTimeoutMs");
    this.hardGraceMs = positiveInteger(hardGraceMs, 2_000, "hardGraceMs");
    this.terminate = terminate;
  }

  async review({ turn_id, policy = "standard", request, signal }: { turn_id: string; policy?: "standard" | "cyber"; request?: unknown; signal?: AbortSignal }): Promise<Readonly<Record<string, unknown>>> {
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
    } catch (error: unknown) {
      if (signal?.aborted) throw error;
      const phase = error && typeof error === "object" && "phase" in error;
      return Object.freeze({
        kind: "human_review_required",
        reason: phase ? "guardian_timeout" : "guardian_unavailable",
      });
    }
  }
}

export function createGuardianReviewCoordinator(options: ConstructorParameters<typeof GuardianReviewCoordinator>[0]): GuardianReviewCoordinator {
  return new GuardianReviewCoordinator(options);
}
