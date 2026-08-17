import { client as generatedClient } from "./generated/client.gen";

export {
  ask,
  decideReview,
  getAsset,
  getAssetContent,
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
  IdempotencyKey2,
  SynthesizeData,
  SynthesizeError,
  SynthesizeErrors,
  SynthesizeResponse,
  SynthesizeResponses,
  TenantId2,
} from "./generated/types.gen";

/** Configure the generated HTTP client's base URL, headers, and fetch implementation. */
export function configureClient(config: Parameters<typeof generatedClient.setConfig>[0]) {
  return generatedClient.setConfig(config);
}
