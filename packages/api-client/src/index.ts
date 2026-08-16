export * from "./generated/index";
import { client as generatedClient } from "./generated/client.gen";

/**
 * The generated client is an implementation detail. Consumers configure it
 * through this stable facade and call generated operations, never low-level
 * `client.get/post` methods or handwritten `/v1/` URLs.
 */
export function configureClient(config: Parameters<typeof generatedClient.setConfig>[0]) {
  return generatedClient.setConfig(config);
}

export type { CloudEventEnvelope, EventType } from "./generated/events.gen";
