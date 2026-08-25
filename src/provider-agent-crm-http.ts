import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  checkedJson,
  parseUnderstanding,
  upstream,
  type FetchImplementation,
  type ProviderAdapter,
} from "./provider-common.ts";

type ProviderEnvironment = Record<string, string | undefined>;

const responseEnvelope = z.strictObject({
  request_id: z.string().min(1).max(256),
  phone_number: z.string().min(1).max(64),
  response: z.string().min(1),
});

function configuredValue(env: ProviderEnvironment, name: string): string {
  return env[name]?.trim() || "";
}

function endpoint(env: ProviderEnvironment): URL {
  const raw = configuredValue(env, "AGENT_CRM_HTTP_URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw upstream("Agent CRM HTTP URL is invalid", error, {
      breakerEligible: false,
    });
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw upstream(
      "Agent CRM HTTP URL must use credential-free HTTPS without a fragment",
      undefined,
      { breakerEligible: false },
    );
  }
  return url;
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
      return Boolean(
        configuredValue(env, "AGENT_CRM_HTTP_URL") &&
          configuredValue(env, "AGENT_CRM_HTTP_MODEL") &&
          configuredValue(env, "AGENT_CRM_HTTP_CALLER_ID"),
      );
    },
    async transcribe() {
      return unsupported("ASR");
    },
    async understand(transcript, { locale, signal }) {
      const requestId = `sumi-${randomUUID()}`;
      const callerId = configuredValue(env, "AGENT_CRM_HTTP_CALLER_ID");
      const model = configuredValue(env, "AGENT_CRM_HTTP_MODEL");
      if (!callerId || !model) {
        throw upstream("Agent CRM HTTP provider is not configured", undefined, {
          breakerEligible: false,
        });
      }
      const token = configuredValue(env, "AGENT_CRM_HTTP_BEARER_TOKEN");
      const response = await fetchImpl(endpoint(env), {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          request_id: requestId,
          phone_number: callerId,
          query: transcript,
        }),
      });
      const body = await checkedJson(response, "Agent CRM HTTP intent");
      const parsed = responseEnvelope.safeParse(body);
      if (!parsed.success || parsed.data.request_id !== requestId) {
        throw upstream("Agent CRM HTTP returned an invalid response envelope");
      }
      return parseUnderstanding(parsed.data.response, {
        transcript,
        locale,
        model,
      });
    },
    async synthesize() {
      return unsupported("TTS");
    },
  };
}
