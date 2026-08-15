---
title: API contract
description: Authentication, tenancy, idempotency, request modes, responses, errors, and the authoritative OpenAPI boundary.
docId: crm.api
locale: en
audience: both
contentVersion: 0.1.0
---

`contracts/openapi.yaml` is the normative HTTP contract. The rendered documentation summarizes it; clients and tests should validate against the OpenAPI document rather than duplicate schemas from this page.

## Common request boundary

Both mutation-capable endpoints require:

| Input | Requirement |
| --- | --- |
| `Authorization` | Development accepts an explicit local bearer. Production verifies OIDC JWT signature, issuer, audience, subject, tenant and configured scope through remote JWKS. |
| `X-Tenant-Id` | Non-empty tenant scope. It must come from an authorized identity boundary, never model text. |
| `Idempotency-Key` | 8 to 128 characters. Reuse with different content returns a conflict. |

## `POST /v1/ask`

The endpoint accepts either JSON text/audio input or multipart audio. `output_mode` is `text`, `audio`, or `both`; supported locale values in the contract are `zh-CN`, `en-US`, `hi-IN`, and `te-IN`.

- `200` means the request completed.
- `202` means low-confidence understanding created a review task and did not commit a CRM mutation.
- `409` covers idempotency or CRM version conflicts.
- `415` covers unsupported media.
- `422` covers validly shaped input that cannot be processed, including empty audio.
- `429`, `503`, and `504` are reserved contract outcomes for limits and provider availability.

## `POST /v1/tts/synthesize`

Accepts text, language, optional voice, and `mp3`, `wav`, or `ogg` format. A successful reference response is a scoped asset descriptor, not public audio storage. Production assets require private storage, access authorization, expiry, and audit.

## Error envelope

```json
{
  "request_id": "req_...",
  "status": "failed",
  "error": {
    "code": "IDEMPOTENCY_CONFLICT",
    "message": "sanitized message",
    "retryable": false,
    "details": {}
  }
}
```

Retry decisions come from `retryable` plus endpoint semantics. A caller must not retry a mutation with a new idempotency key just to bypass a conflict.

## Reference-only routes

The runtime also exposes health checks, a tenant-filtered event view, and mock asset lookup for local verification. They are not part of the current public OpenAPI surface and must not be treated as production operator APIs until their authentication, pagination, schemas, and lifecycle are contracted.
