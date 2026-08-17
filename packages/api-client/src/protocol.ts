/**
 * Transport-neutral data contracts generated from the reviewed OpenAPI and
 * event schemas. This module contains no client configuration or I/O logic.
 */
export type {
  AskRequest,
  AskResponse,
  AssetId,
  AttachmentId,
  AttachmentKind,
  AttachmentMimeType,
  AttachmentRef,
  AttachmentSha256,
  AudioAskRequest,
  AudioInput,
  ErrorEnvelope,
  IdempotencyKey,
  Locale,
  MultipartAskMetadata,
  MultipartAudioAskRequest,
  RequestId,
  ReviewDecisionRequest,
  ReviewDecisionResponse,
  ReviewId,
  ReviewResponse,
  TenantId,
  TextAskRequest,
  TextInput,
  TtsAsset,
  TtsRequest,
  TtsSynthesizeResponse,
  Understanding,
} from "./generated/types.gen";

export type { CloudEventEnvelope, EventType } from "./generated/events.gen";
