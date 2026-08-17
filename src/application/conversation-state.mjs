const MAX_CONVERSATION_STATE_BYTES = 64 * 1024;

function invalid(message) {
  return Object.assign(new Error(message), { code: "INVALID_REQUEST" });
}

function validateConversationId(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 128) {
    throw invalid("conversation_id must contain 1-128 characters");
  }
  return value;
}

function validateRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalid("expected_revision must be a non-negative integer");
  }
  return value;
}

function validateState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("conversation state must be an object");
  }
  let encoded;
  let cloned;
  try {
    encoded = JSON.stringify(value);
    cloned = structuredClone(value);
  } catch {
    throw invalid("conversation state must be JSON serializable");
  }
  if (Buffer.byteLength(encoded) > MAX_CONVERSATION_STATE_BYTES) {
    throw invalid(`conversation state exceeds ${MAX_CONVERSATION_STATE_BYTES} bytes`);
  }
  return cloned;
}

export class ConversationStateService {
  constructor({ store } = {}) {
    for (const method of ["initializeConversationState", "conversationState", "replaceConversationStateIfCurrent"]) {
      if (typeof store?.[method] !== "function") throw new TypeError(`conversation state store must implement ${method}()`);
    }
    this.store = store;
  }

  async initialize(context, { conversation_id, state = {} } = {}) {
    return await this.store.initializeConversationState({
      ...context.identity,
      conversation_id: validateConversationId(conversation_id),
      state: validateState(state),
    });
  }

  async read(context, { conversation_id } = {}) {
    return await this.store.conversationState({
      ...context.identity,
      conversation_id: validateConversationId(conversation_id),
    });
  }

  async replace(context, { conversation_id, expected_revision, state } = {}) {
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
