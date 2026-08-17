import {
  ask,
  configureClient,
  decideReview,
  getAssetContent,
} from "../../packages/api-client/src/api";
import type {
  AskRequest,
  AskResponse,
  AudioInput,
  ErrorEnvelope,
  Locale,
  ReviewDecisionRequest,
  ReviewDecisionResponse,
  ReviewResponse,
  TtsAsset,
  Understanding,
} from "../../packages/api-client/src/protocol";

type UiPhase = "idle" | "capturing" | "submitting" | "awaiting_review" | "completed" | "error";
type ApiResult<TData> = { data?: TData; error?: unknown };

const root = document.documentElement;
const apiBaseUrl = root.dataset.apiBaseUrl ?? window.location.origin;
configureClient({ baseUrl: apiBaseUrl });

const form = document.querySelector<HTMLFormElement>("#ask-form")!;
const submit = document.querySelector<HTMLButtonElement>("#submit-ask")!;
const status = document.querySelector<HTMLElement>("#status")!;
const result = document.querySelector<HTMLElement>("#result")!;
const fallback = document.querySelector<HTMLElement>("#fallback")!;
const record = document.querySelector<HTMLButtonElement>("#record")!;
const locale = document.querySelector<HTMLSelectElement>("#locale")!;
const tenant = document.querySelector<HTMLInputElement>("#tenant")!;
const token = document.querySelector<HTMLInputElement>("#token")!;
const text = document.querySelector<HTMLTextAreaElement>("#text")!;
const audioWrap = document.querySelector<HTMLElement>("#audio-wrap")!;
const audio = document.querySelector<HTMLAudioElement>("#audio")!;
const audioLink = document.querySelector<HTMLAnchorElement>("#audio-link")!;
const reviewPanel = document.querySelector<HTMLElement>("#review-panel")!;
const reviewSummary = document.querySelector<HTMLElement>("#review-summary")!;
const reviewMeta = document.querySelector<HTMLElement>("#review-meta")!;
const reviewUnderstanding = document.querySelector<HTMLElement>("#review-understanding")!;
const reviewCorrection = document.querySelector<HTMLTextAreaElement>("#review-correction")!;
const reviewError = document.querySelector<HTMLElement>("#review-error")!;
const approveReview = document.querySelector<HTMLButtonElement>("#approve-review")!;
const rejectReview = document.querySelector<HTMLButtonElement>("#reject-review")!;

const phaseLabels: Record<UiPhase, string> = {
  idle: "就绪",
  capturing: "录音中…",
  submitting: "同步请求处理中…",
  awaiting_review: "需要人工确认；CRM 尚未写入",
  completed: "完成",
  error: "请求失败，自动处理已停止",
};

const selectedLocale = () => locale.value as Locale;
const requestHeaders = () => ({
  Authorization: "Bearer " + token.value.trim(),
  "X-Tenant-Id": tenant.value.trim(),
  "Idempotency-Key": crypto.randomUUID(),
});

let activeReviewId: string | undefined;
let reviewReturnFocus: HTMLElement | undefined;
let recorder: MediaRecorder | undefined;
let stream: MediaStream | undefined;
let capturePending = false;
let requestInFlight = false;
let audioObjectUrl: string | undefined;
let audioLoadId = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isUnderstanding(value: unknown): value is Understanding {
  if (!isRecord(value) || !isRecord(value.entities)) return false;
  return (
    typeof value.intent === "string" &&
    typeof value.confidence === "number" &&
    Number.isFinite(value.confidence) &&
    isStringArray(value.missing) &&
    typeof value.needs_confirmation === "boolean" &&
    typeof value.schema_version === "string"
  );
}

function isTtsAsset(value: unknown): value is TtsAsset {
  if (!isRecord(value)) return false;
  return (
    typeof value.asset_id === "string" &&
    typeof value.url === "string" &&
    typeof value.mime_type === "string" &&
    ["ready", "failed", "pending"].includes(String(value.status))
  );
}

function isAskPayload(value: unknown): value is AskResponse {
  if (!isRecord(value) || !isRecord(value.input) || !isRecord(value.answer)) return false;
  return (
    value.status === "completed" &&
    typeof value.request_id === "string" &&
    isUnderstanding(value.understanding) &&
    typeof value.answer.text === "string" &&
    (value.audio === undefined || isTtsAsset(value.audio))
  );
}

function isReviewPayload(value: unknown): value is ReviewResponse {
  if (!isRecord(value) || !isRecord(value.input) || !isRecord(value.answer) || !isRecord(value.review_task)) {
    return false;
  }
  return (
    value.status === "needs_review" &&
    typeof value.request_id === "string" &&
    isUnderstanding(value.understanding) &&
    typeof value.answer.text === "string" &&
    typeof value.review_task.id === "string"
  );
}

function isReviewDecisionPayload(value: unknown): value is ReviewDecisionResponse {
  return (
    isRecord(value) &&
    typeof value.review_id === "string" &&
    (value.status === "approved" || value.status === "rejected") &&
    isRecord(value.decision)
  );
}

function isErrorPayload(value: unknown): value is ErrorEnvelope {
  if (!isRecord(value) || !isRecord(value.error) || !isRecord(value.error.details)) return false;
  return (
    value.status === "failed" &&
    typeof value.request_id === "string" &&
    typeof value.error.code === "string" &&
    typeof value.error.message === "string" &&
    typeof value.error.retryable === "boolean"
  );
}

function jsonText(value: unknown) {
  return JSON.stringify(value, null, 2) ?? String(value);
}

function setPhase(next: UiPhase) {
  status.dataset.phase = next;
  status.textContent = phaseLabels[next];
}

function isRecording() {
  return recorder?.state === "recording";
}

function syncControls() {
  const recording = isRecording();
  submit.disabled = requestInFlight || capturePending || recording;
  record.disabled = requestInFlight || capturePending;
  text.disabled = requestInFlight || capturePending || recording;
  tenant.disabled = requestInFlight || capturePending || recording;
  token.disabled = requestInFlight || capturePending || recording;
  locale.disabled = requestInFlight || capturePending || recording;
  approveReview.disabled = requestInFlight || !activeReviewId;
  rejectReview.disabled = requestInFlight || !activeReviewId;
}

function clearAudio() {
  audioLoadId += 1;
  audio.pause();
  audio.removeAttribute("src");
  audioLink.removeAttribute("href");
  audioWrap.hidden = true;
  if (audioObjectUrl) {
    URL.revokeObjectURL(audioObjectUrl);
    audioObjectUrl = undefined;
  }
}

async function showAudio(asset: TtsAsset | undefined) {
  clearAudio();
  if (!asset || asset.status !== "ready" || !asset.asset_id) return;
  const loadId = audioLoadId;
  try {
    const response = await getAssetContent({
      headers: requestHeaders(),
      path: { asset_id: asset.asset_id },
      parseAs: "blob",
    });
    if (loadId !== audioLoadId) return;
    if (response.error !== undefined) {
      if (isErrorPayload(response.error)) showError(response.error);
      else showMalformed(response.error);
      return;
    }
    if (!(response.data instanceof Blob)) {
      showMalformed(response.data);
      return;
    }
    const objectUrl = URL.createObjectURL(response.data);
    if (loadId !== audioLoadId) {
      URL.revokeObjectURL(objectUrl);
      return;
    }
    audioObjectUrl = objectUrl;
    audio.src = objectUrl;
    audioLink.href = objectUrl;
    audioWrap.hidden = false;
    audio.load();
  } catch (error) {
    if (loadId === audioLoadId) showClientError(error);
  }
}

function closeReview({ restoreFocus = true } = {}) {
  activeReviewId = undefined;
  reviewPanel.hidden = true;
  reviewError.textContent = "";
  reviewCorrection.value = "";
  syncControls();
  if (restoreFocus && reviewReturnFocus?.isConnected) reviewReturnFocus.focus({ preventScroll: true });
  reviewReturnFocus = undefined;
}

function showReview(payload: ReviewResponse) {
  activeReviewId = payload.review_task.id;
  reviewSummary.textContent = payload.answer.text || "服务端已暂停 CRM 写入。";
  reviewMeta.textContent = `intent: ${payload.understanding.intent} · review: ${activeReviewId}`;
  reviewUnderstanding.textContent = jsonText(payload.understanding);
  reviewCorrection.value = "";
  reviewError.textContent = "";
  reviewPanel.hidden = false;
  syncControls();
  setPhase("awaiting_review");
  reviewPanel.focus({ preventScroll: true });
}

function showError(payload: ErrorEnvelope, { keepReview = false } = {}) {
  result.textContent = jsonText(payload);
  fallback.hidden = false;
  clearAudio();
  if (!keepReview) closeReview();
  setPhase("error");
  syncControls();
}

function showMalformed(payload: unknown, { keepReview = false } = {}) {
  result.textContent = jsonText({ error: "Unexpected API response", payload });
  fallback.hidden = false;
  clearAudio();
  if (!keepReview) closeReview();
  setPhase("error");
  syncControls();
}

function showClientError(error: unknown, { keepReview = false } = {}) {
  result.textContent = error instanceof Error ? error.message : String(error);
  fallback.hidden = false;
  clearAudio();
  if (!keepReview) closeReview();
  setPhase("error");
  syncControls();
}

function showAskResult(payload: AskResponse) {
  result.textContent = jsonText(payload);
  fallback.hidden = true;
  closeReview();
  showAudio(payload.audio);
  setPhase("completed");
}

function consumeAskResult(response: ApiResult<AskResponse | ReviewResponse>) {
  if (response.error !== undefined) {
    if (isErrorPayload(response.error)) showError(response.error);
    else showMalformed(response.error);
    return;
  }
  if (isAskPayload(response.data)) {
    showAskResult(response.data);
    return;
  }
  if (isReviewPayload(response.data)) {
    result.textContent = jsonText(response.data);
    fallback.hidden = true;
    clearAudio();
    showReview(response.data);
    return;
  }
  showMalformed(response.data);
}

function consumeReviewResult(response: ApiResult<ReviewDecisionResponse>) {
  if (response.error !== undefined) {
    if (isErrorPayload(response.error)) showError(response.error, { keepReview: true });
    else showMalformed(response.error, { keepReview: true });
    return;
  }
  if (!isReviewDecisionPayload(response.data)) {
    showMalformed(response.data, { keepReview: true });
    return;
  }
  result.textContent = jsonText(response.data);
  fallback.hidden = true;
  clearAudio();
  closeReview();
  setPhase("completed");
}

function credentialsAreValid() {
  return tenant.reportValidity() && token.reportValidity();
}

async function submitAsk(body: AskRequest) {
  if (requestInFlight || capturePending || isRecording()) return;
  reviewReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : submit;
  requestInFlight = true;
  fallback.hidden = true;
  setPhase("submitting");
  syncControls();
  try {
    consumeAskResult(await ask({ headers: requestHeaders(), body }));
  } catch (error) {
    showClientError(error);
  } finally {
    requestInFlight = false;
    syncControls();
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!credentialsAreValid()) return;
  const requestText = text.value.trim();
  if (!requestText) {
    text.setCustomValidity("请输入问题或 CRM 指令");
    text.reportValidity();
    return;
  }
  text.setCustomValidity("");
  await submitAsk({
    input: { type: "text", text: requestText },
    output_mode: "both",
    locale: selectedLocale(),
  });
});

text.addEventListener("input", () => text.setCustomValidity(""));

function base64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("error", () => reject(reader.error ?? new Error("audio could not be read")), { once: true });
    reader.addEventListener("load", () => resolve(String(reader.result).split(",", 2)[1] ?? ""), { once: true });
    reader.readAsDataURL(blob);
  });
}

function recorderMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm"];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
}

function stopTracks(target: MediaStream | undefined) {
  target?.getTracks().forEach((track) => track.stop());
  if (stream === target) stream = undefined;
}

function resetRecorder(target: MediaRecorder | undefined) {
  if (recorder === target) recorder = undefined;
  capturePending = false;
  record.textContent = "开始录音";
  syncControls();
}

async function sendRecording(target: MediaRecorder, targetStream: MediaStream, chunks: Blob[]) {
  stopTracks(targetStream);
  if (recorder === target) recorder = undefined;
  record.textContent = "开始录音";
  capturePending = true;
  syncControls();
  const blob = new Blob(chunks, { type: target.mimeType || "audio/webm" });
  if (blob.size === 0) {
    capturePending = false;
    syncControls();
    showClientError(new Error("没有采集到音频，请检查麦克风后重试"));
    return;
  }
  try {
    const data_base64 = await base64(blob);
    if (!data_base64) throw new Error("没有采集到可发送的音频");
    const content_type = (target.mimeType.split(";", 1)[0] || "audio/webm") as AudioInput["content_type"];
    capturePending = false;
    await submitAsk({
      input: { type: "audio", data_base64, content_type },
      output_mode: "both",
      locale: selectedLocale(),
    });
  } catch (error) {
    capturePending = false;
    syncControls();
    showClientError(error);
  }
}

record.addEventListener("click", async () => {
  if (requestInFlight || capturePending) return;
  if (isRecording()) {
    capturePending = true;
    syncControls();
    try {
      recorder?.stop();
    } catch (error) {
      const failedRecorder = recorder;
      const failedStream = stream;
      stopTracks(failedStream);
      resetRecorder(failedRecorder);
      showClientError(error);
    }
    return;
  }
  if (!credentialsAreValid()) return;

  capturePending = true;
  syncControls();
  let acquiredStream: MediaStream | undefined;
  let nextRecorder: MediaRecorder | undefined;
  try {
    acquiredStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = recorderMimeType();
    nextRecorder = mimeType
      ? new MediaRecorder(acquiredStream, { mimeType })
      : new MediaRecorder(acquiredStream);
    const nextChunks: Blob[] = [];
    let settled = false;
    nextRecorder.addEventListener("dataavailable", (event: BlobEvent) => {
      if (event.data.size > 0) nextChunks.push(event.data);
    });
    nextRecorder.addEventListener("stop", () => {
      if (settled) return;
      settled = true;
      void sendRecording(nextRecorder!, acquiredStream!, nextChunks);
    }, { once: true });
    nextRecorder.addEventListener("error", (event) => {
      if (settled) return;
      settled = true;
      stopTracks(acquiredStream);
      resetRecorder(nextRecorder);
      showClientError(event.error ?? new Error("录音失败"));
    }, { once: true });
    stream = acquiredStream;
    recorder = nextRecorder;
    nextRecorder.start();
    capturePending = false;
    record.textContent = "停止并发送";
    setPhase("capturing");
    syncControls();
  } catch (error) {
    stopTracks(acquiredStream);
    resetRecorder(nextRecorder);
    showClientError(error);
  }
});

function parseCorrection(): ReviewDecisionRequest["correction"] | undefined {
  const raw = reviewCorrection.value.trim();
  if (!raw) return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error("校正 JSON 必须是对象");
  return parsed;
}

async function decide(decision: "approve" | "reject") {
  if (!activeReviewId || requestInFlight) return;
  let correction: ReviewDecisionRequest["correction"] | undefined;
  if (decision === "approve") {
    try {
      correction = parseCorrection();
      reviewError.textContent = "";
    } catch (error) {
      reviewError.textContent = error instanceof Error ? error.message : "校正 JSON 无法解析";
      setPhase("awaiting_review");
      reviewCorrection.focus();
      return;
    }
  }

  requestInFlight = true;
  setPhase("submitting");
  syncControls();
  const body: ReviewDecisionRequest = correction === undefined ? { decision } : { decision, correction };
  try {
    consumeReviewResult(await decideReview({
      headers: requestHeaders(),
      path: { review_id: activeReviewId },
      body,
    }));
  } catch (error) {
    showClientError(error, { keepReview: true });
  } finally {
    requestInFlight = false;
    syncControls();
  }
}

approveReview.addEventListener("click", () => void decide("approve"));
rejectReview.addEventListener("click", () => void decide("reject"));
window.addEventListener("pagehide", () => {
  stopTracks(stream);
  clearAudio();
});

syncControls();
