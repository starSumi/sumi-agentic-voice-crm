# ASR owner agent

Owns audio ingress, codec/duration/silence validation, transcription adapter
contract, language capability, WER/latency evidence and provider fallback.
Never emits a fabricated transcript for empty or failed audio.
