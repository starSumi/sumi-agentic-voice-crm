const MAX_CONVERSATION_STATE_BYTES = 64 * 1024;

type RuntimeError = Error & { code: string };
type ConversationState = Record<string, unknown>;
type ConversationContext = {
  readonly identity: Readonly<Record<string, unknown>>;
};
type ConversationStore = {
  initializeConversationState(input: Record<string, unknown>): Promise<unknown>;
  conversationState(input: Record<string, unknown>): Promise<unknown>;
  replaceConversationStateIfCurrent(input: Record<string, unknown>): Promise<{ replaced: boolean; [key: string]: unknown }>;
};

function invalid(message: string): RuntimeError {
  return Object.assign(new Error(message), { code: "INVALID_REQUEST" });
}

function validateConversationId(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 128) {
    throw invalid("conversation_id must contain 1-128 characters");
  }
  return value;
}

function validateRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalid("expected_revision must be a non-negative integer");
  }
  return value;
}

function validateState(value: unknown): ConversationState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("conversation state must be an object");
  }
  let encoded: string;
  let cloned: unknown;
  try {
    encoded = JSON.stringify(value) ?? "";
    cloned = structuredClone(value);
  } catch {
    throw invalid("conversation state must be JSON serializable");
  }
  if (Buffer.byteLength(encoded) > MAX_CONVERSATION_STATE_BYTES) {
    throw invalid(`conversation state exceeds ${MAX_CONVERSATION_STATE_BYTES} bytes`);
  }
  return cloned as ConversationState;
}

export class ConversationStateService {
  readonly store: ConversationStore;

  constructor({ store }: { store?: ConversationStore } = {}) {
    const methods: readonly (keyof ConversationStore)[] = ["initializeConversationState", "conversationState", "replaceConversationStateIfCurrent"];
    for (const method of methods) {
      if (typeof store?.[method] !== "function") throw new TypeError(`conversation state store must implement ${method}()`);
    }
    if (!store) throw new TypeError("conversation state store is required");
    this.store = store;
  }

  async initialize(context: ConversationContext, { conversation_id, state = {} }: { conversation_id?: unknown; state?: unknown } = {}): Promise<unknown> {
    return await this.store.initializeConversationState({
      ...context.identity,
      conversation_id: validateConversationId(conversation_id),
      state: validateState(state),
    });
  }

  async read(context: ConversationContext, { conversation_id }: { conversation_id?: unknown } = {}): Promise<unknown> {
    return await this.store.conversationState({
      ...context.identity,
      conversation_id: validateConversationId(conversation_id),
    });
  }

  async replace(context: ConversationContext, { conversation_id, expected_revision, state }: { conversation_id?: unknown; expected_revision?: unknown; state?: unknown } = {}): Promise<{ replaced: boolean; [key: string]: unknown }> {
    const result = await this.store.replaceConversationStateIfCurrent({
      ...context.identity,
      conversation_id: validateConversationId(conversation_id),
      expected_revision: validateRevision(expected_revision),
      state: validateState(state),
    });
    if (!result.replaced) {
      throw Object.assign(new Error("conversation changed while the state was being replaced"), {
        code: "CRM_CONFLICT",
      });
    }
    return result;
  }
}

export { MAX_CONVERSATION_STATE_BYTES };
