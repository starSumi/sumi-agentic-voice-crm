export const GUARDIAN_POLICIES = Object.freeze({
  standard: Object.freeze({ max_consecutive: 3, window_size: 50, max_recent: 10 }),
  cyber: Object.freeze({ max_consecutive: 1, window_size: 50, max_recent: 1 }),
});

type GuardianPolicyName = keyof typeof GUARDIAN_POLICIES;
type GuardianPolicy = (typeof GUARDIAN_POLICIES)[GuardianPolicyName];
type GuardianTurn = {
  policy?: GuardianPolicyName;
  consecutive_denials: number;
  recent_denials: boolean[];
  interrupt_triggered: boolean;
  updated_at_ms: number;
};

function policyFor(name: string): GuardianPolicy {
  const policy = Object.hasOwn(GUARDIAN_POLICIES, name)
    ? GUARDIAN_POLICIES[name as GuardianPolicyName]
    : undefined;
  if (!policy) throw new TypeError(`unknown Guardian denial policy: ${name}`);
  return policy;
}

function turnId(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 128) {
    throw new TypeError("Guardian turn_id must contain 1-128 characters");
  }
  return value;
}

/**
 * Semantic safety governor for Guardian decisions. This is intentionally
 * separate from provider availability circuits and never performs I/O.
 */
export class GuardianDenialGovernor {
  #turns = new Map<string, GuardianTurn>();
  readonly maxTurns: number;
  readonly idleTtlMs: number;
  readonly now: () => number;

  constructor({ maxTurns = 1_000, idleTtlMs = 30 * 60_000, now = () => Date.now() }: { maxTurns?: number; idleTtlMs?: number; now?: () => number } = {}) {
    if (!Number.isSafeInteger(maxTurns) || maxTurns <= 0) throw new TypeError("maxTurns must be a positive integer");
    if (!Number.isSafeInteger(idleTtlMs) || idleTtlMs <= 0) throw new TypeError("idleTtlMs must be a positive integer");
    this.maxTurns = maxTurns;
    this.idleTtlMs = idleTtlMs;
    this.now = now;
  }

  recordDenial(id: unknown, policyName: GuardianPolicyName = "standard") {
    const policy = policyFor(policyName);
    const turn = this.#getTurn(turnId(id));
    turn.policy = policyName;
    turn.consecutive_denials += 1;
    this.#recordRecent(turn, true, policy.window_size);
    const recentDenials = turn.recent_denials.filter(Boolean).length;
    const shouldInterrupt = turn.consecutive_denials >= policy.max_consecutive || recentDenials >= policy.max_recent;
    const newlyTriggered = shouldInterrupt && !turn.interrupt_triggered;
    if (shouldInterrupt) turn.interrupt_triggered = true;
    return Object.freeze({
      kind: turn.interrupt_triggered ? "interrupt_turn" : "continue",
      policy: policyName,
      consecutive_denials: turn.consecutive_denials,
      recent_denials: recentDenials,
      newly_triggered: newlyTriggered,
    });
  }

  recordNonDenial(id: unknown, policyName: GuardianPolicyName = "standard") {
    const policy = policyFor(policyName);
    const turn = this.#getTurn(turnId(id));
    turn.policy = policyName;
    turn.consecutive_denials = 0;
    this.#recordRecent(turn, false, policy.window_size);
    return Object.freeze({
      kind: turn.interrupt_triggered ? "interrupt_turn" : "continue",
      policy: policyName,
      consecutive_denials: 0,
      recent_denials: turn.recent_denials.filter(Boolean).length,
      newly_triggered: false,
    });
  }

  clearTurn(id: unknown): boolean {
    return this.#turns.delete(turnId(id));
  }

  snapshot(id: unknown): Readonly<Record<string, unknown>> | undefined {
    const turn = this.#turns.get(turnId(id));
    if (!turn) return undefined;
    return Object.freeze({
      policy: turn.policy,
      consecutive_denials: turn.consecutive_denials,
      recent_denials: turn.recent_denials.filter(Boolean).length,
      review_count: turn.recent_denials.length,
      interrupt_triggered: turn.interrupt_triggered,
      updated_at_ms: turn.updated_at_ms,
    });
  }

  #getTurn(id: string): GuardianTurn {
    const timestamp = this.now();
    for (const [key, turn] of this.#turns) {
      if (timestamp - turn.updated_at_ms >= this.idleTtlMs) this.#turns.delete(key);
    }
    let turn = this.#turns.get(id);
    if (!turn) {
      if (this.#turns.size >= this.maxTurns) {
        const oldest = [...this.#turns.entries()].sort((left, right) => left[1].updated_at_ms - right[1].updated_at_ms)[0];
        if (oldest) this.#turns.delete(oldest[0]);
      }
      turn = { consecutive_denials: 0, recent_denials: [], interrupt_triggered: false, updated_at_ms: timestamp };
      this.#turns.set(id, turn);
    }
    turn.updated_at_ms = timestamp;
    return turn;
  }

  #recordRecent(turn: GuardianTurn, denied: boolean, windowSize: number): void {
    turn.recent_denials.push(denied);
    if (turn.recent_denials.length > windowSize) turn.recent_denials.shift();
  }
}

export function createGuardianDenialGovernor(options?: ConstructorParameters<typeof GuardianDenialGovernor>[0]): GuardianDenialGovernor {
  return new GuardianDenialGovernor(options);
}
