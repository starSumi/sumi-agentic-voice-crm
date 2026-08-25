import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  assertProviderResponse,
  checkedJson,
  parseUnderstanding,
  upstream,
  type FetchImplementation,
  type ProviderAdapter,
} from "./provider-common.ts";

type ProviderEnvironment = Record<string, string | undefined>;
type AgentCrmHttpConfiguration = Readonly<{
  url: URL;
  model: string;
  callerId: string;
  token: string;
}>;

const OPAQUE_CALLER_ID =
  /^sumi-caller-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const responseEnvelope = z.strictObject({
  request_id: z.string().min(1).max(256),
  phone_number: z.string().min(1).max(64),
  response: z.string().min(1),
});

function configuredValue(env: ProviderEnvironment, name: string): string {
  return env[name]?.trim() || "";
}

export function agentCrmHttpConfiguration(
  env: ProviderEnvironment,
): AgentCrmHttpConfiguration {
  const raw = configuredValue(env, "AGENT_CRM_HTTP_URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError("AGENT_CRM_HTTP_URL must be an absolute URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new TypeError(
      "AGENT_CRM_HTTP_URL must use credential-free HTTPS without a fragment",
    );
  }
  const model = configuredValue(env, "AGENT_CRM_HTTP_MODEL");
  if (!model || model.length > 256) {
    throw new TypeError("AGENT_CRM_HTTP_MODEL must contain 1 to 256 characters");
  }
  const callerId = configuredValue(env, "AGENT_CRM_HTTP_CALLER_ID");
  if (!OPAQUE_CALLER_ID.test(callerId)) {
    throw new TypeError(
      "AGENT_CRM_HTTP_CALLER_ID must use the non-PII sumi-caller-<UUID> format",
    );
  }
  const token = configuredValue(env, "AGENT_CRM_HTTP_BEARER_TOKEN");
  if (token && (token.length > 8_192 || /[\u0000-\u0020\u007f]/u.test(token))) {
    throw new TypeError("AGENT_CRM_HTTP_BEARER_TOKEN is invalid");
  }
  return Object.freeze({ url, model, callerId, token });
}

function unsupported(capability: string): never {
  throw upstream(`Agent CRM HTTP does not implement ${capability}`, undefined, {
    breakerEligible: false,
  });
}

export function createAgentCrmHttpProvider({
  env,
  fetchImpl,
}: {
  env: ProviderEnvironment;
  fetchImpl: FetchImplementation;
}): ProviderAdapter {
  return {
    name: "agent-crm-http",
    defaultTtsFormat: "wav",
    configured(kind) {
      if (kind !== undefined && kind !== "intent") return false;
      try {
        agentCrmHttpConfiguration(env);
        return true;
      } catch {
        return false;
      }
    },
    async transcribe() {
      return unsupported("ASR");
    },
    async understand(transcript, { locale, signal }) {
      let configuration: AgentCrmHttpConfiguration;
      try {
        configuration = agentCrmHttpConfiguration(env);
      } catch (error) {
        throw upstream("Agent CRM HTTP provider is not configured", error, {
          breakerEligible: false,
        });
      }
      const requestId = `sumi-${randomUUID()}`;
      const response = await fetchImpl(configuration.url, {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          "content-type": "application/json",
          ...(configuration.token
            ? { authorization: `Bearer ${configuration.token}` }
            : {}),
        },
        body: JSON.stringify({
          request_id: requestId,
          phone_number: configuration.callerId,
          query: transcript,
        }),
      });
      if (!response.ok) {
        assertProviderResponse(response, "Agent CRM HTTP intent");
      }
      if (!/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "")) {
        throw upstream("Agent CRM HTTP returned a non-JSON content type");
      }
      const body = await checkedJson(response, "Agent CRM HTTP intent");
      const parsed = responseEnvelope.safeParse(body);
      if (
        !parsed.success ||
        parsed.data.request_id !== requestId ||
        parsed.data.phone_number !== configuration.callerId
      ) {
        throw upstream("Agent CRM HTTP returned an invalid response envelope");
      }
      return parseUnderstanding(parsed.data.response, {
        transcript,
        locale,
        model: configuration.model,
      });
    },
    async synthesize() {
      return unsupported("TTS");
    },
  };
}
