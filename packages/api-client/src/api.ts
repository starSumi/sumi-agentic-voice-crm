import { client as generatedClient } from "./generated/client.gen";

export {
  selectTransport,
  sendWithFallback,
  TRANSPORT_PREFERENCES,
  type TransportAdapter,
  type TransportCapabilities,
  type TransportClientScope,
  type TransportKind,
  type TransportSelectionOptions,
} from "./transport";

export {
  ask,
  decideReview,
  getAsset,
  getAssetContent,
  getMessageJob,
  listEvents,
  listMessageJobStats,
  type Options,
  synthesize,
} from "./generated/sdk.gen";

export type {
  AskData,
  AskError,
  AskErrors,
  AskResponse2,
  AskResponses,
  ClientOptions,
  DecideReviewData,
  DecideReviewError,
  DecideReviewErrors,
  DecideReviewResponse,
  DecideReviewResponses,
  GetAssetContentData,
  GetAssetContentError,
  GetAssetContentErrors,
  GetAssetContentResponse,
  GetAssetContentResponses,
  GetAssetData,
  GetAssetError,
  GetAssetErrors,
  GetAssetResponse,
  GetAssetResponses,
  GetMessageJobData,
  GetMessageJobError,
  GetMessageJobErrors,
  GetMessageJobResponse,
  GetMessageJobResponses,
  IdempotencyKey2,
  ListEventsData,
  ListEventsError,
  ListEventsErrors,
  ListEventsResponse,
  ListEventsResponses,
  ListMessageJobStatsData,
  ListMessageJobStatsError,
  ListMessageJobStatsErrors,
  ListMessageJobStatsResponse,
  ListMessageJobStatsResponses,
  MessageJobResponse,
  MessageJobStatsResponse,
  JobId,
  PreferAsync,
  SynthesizeData,
  SynthesizeError,
  SynthesizeErrors,
  SynthesizeResponse,
  SynthesizeResponses,
  TenantId2,
} from "./generated/types.gen";

/** Configure the generated HTTP client's base URL, headers, and fetch implementation. */
export function configureClient(
  config: Parameters<typeof generatedClient.setConfig>[0],
) {
  return generatedClient.setConfig(config);
}
