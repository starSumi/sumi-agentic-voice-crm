import { ask, client, type Locale, type AudioInput } from "../../packages/api-client/src/index";

client.setConfig({ baseUrl: "http://127.0.0.1:8080" });
const form = document.querySelector<HTMLFormElement>("#ask-form")!;
const status = document.querySelector<HTMLElement>("#status")!;
const result = document.querySelector<HTMLElement>("#result")!;
const record = document.querySelector<HTMLButtonElement>("#record")!;
const locale = document.querySelector<HTMLSelectElement>("#locale")!;
const tenant = document.querySelector<HTMLInputElement>("#tenant")!;
const token = document.querySelector<HTMLInputElement>("#token")!;
const text = document.querySelector<HTMLTextAreaElement>("#text")!;
const selectedLocale = () => locale.value as Locale;
const headers = () => ({ Authorization: `Bearer ${token.value}`, "X-Tenant-Id": tenant.value, "Idempotency-Key": crypto.randomUUID() });
const show = (body: unknown) => { result.textContent = JSON.stringify(body, null, 2); status.textContent = (body as { status?: string })?.status === "needs_review" ? "需要人工确认；未写入 CRM" : "完成"; };

form.addEventListener("submit", async (event) => {
  event.preventDefault(); status.textContent="处理中…";
  try { const response = await ask({ headers:headers(), body:{ input:{type:"text",text:text.value}, output_mode:"both", locale:selectedLocale() } }); show(response.data ?? response.error); }
  catch(error){ status.textContent="请求失败"; result.textContent=String(error); }
});

let recorder: MediaRecorder | undefined; let stream: MediaStream | undefined; let chunks: Blob[]=[];
const base64 = (blob: Blob) => new Promise<string>((resolve,reject) => { const reader=new FileReader(); reader.onerror=reject; reader.onload=()=>resolve(String(reader.result).split(",",2)[1] ?? ""); reader.readAsDataURL(blob); });
record.addEventListener("click", async () => {
  if (recorder?.state === "recording") { recorder.stop(); record.textContent="开始录音"; return; }
  try {
    stream=await navigator.mediaDevices.getUserMedia({audio:true}); chunks=[]; recorder=new MediaRecorder(stream);
    recorder.ondataavailable=(e: BlobEvent)=>chunks.push(e.data);
    recorder.onstop=async()=>{ stream?.getTracks().forEach(t=>t.stop()); status.textContent="上传语音…"; const current=recorder!; const blob=new Blob(chunks,{type:current.mimeType}); const data_base64=await base64(blob); const input: AudioInput = { type:"audio", data_base64, content_type:current.mimeType.split(";")[0] as AudioInput["content_type"] }; const response=await ask({headers:headers(),body:{input,output_mode:"both",locale:selectedLocale()}}); show(response.data ?? response.error); };
    recorder.start(); record.textContent="停止并发送"; status.textContent="录音中…";
  } catch(error){ status.textContent="无法使用麦克风"; result.textContent=String(error); }
});
