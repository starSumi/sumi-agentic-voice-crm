---
title: Quickstart
description: Run the deterministic reference service, submit a text or mock-audio request, and verify the resulting CRM event.
docId: crm.quickstart
locale: en
audience: both
contentVersion: 0.1.0
---

```powershell
Copy-Item .env.example .env
pnpm test
pnpm run check
pnpm run build
pnpm start
```

```powershell
$h=@{Authorization='Bearer local-actor';'X-Tenant-Id'='tenant_demo';'Idempotency-Key'='quickstart-001'}
Invoke-RestMethod http://localhost:8080/v1/ask -Method Post -Headers $h -ContentType 'application/json' -Body (@{input=@{type='text';text='move Acme renewal to Negotiation'};output_mode='both';locale='en-US'}|ConvertTo-Json -Depth 5)
```

Verify the no-audio boundary:

```powershell
$h=@{Authorization='Bearer local-actor';'X-Tenant-Id'='tenant_demo';'Idempotency-Key'='quickstart-no-audio'}
try { Invoke-RestMethod http://localhost:8080/v1/ask -Method Post -Headers $h -ContentType 'application/json' -Body '{"input":{"type":"audio","audio":null},"output_mode":"text"}' } catch { $_.ErrorDetails.Message }
```

Before connecting a real provider, pass the mock contract tests. Never place a real key in `.env.example`, logs, test fixtures, or Postman.
