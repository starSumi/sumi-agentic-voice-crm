# Quickstart

```powershell
Copy-Item .env.example .env
npm test
npm run check
npm run build
npm start
```

```powershell
$h=@{Authorization='Bearer local-actor';'X-Tenant-Id'='tenant_demo';'Idempotency-Key'='quickstart-001'}
Invoke-RestMethod http://localhost:8080/v1/ask -Method Post -Headers $h -ContentType 'application/json' -Body (@{input=@{type='text';text='move Acme renewal to Negotiation'};output_mode='both';locale='en-US'}|ConvertTo-Json -Depth 5)
```

无音源边界：

```powershell
$h=@{Authorization='Bearer local-actor';'X-Tenant-Id'='tenant_demo';'Idempotency-Key'='quickstart-no-audio'}
try { Invoke-RestMethod http://localhost:8080/v1/ask -Method Post -Headers $h -ContentType 'application/json' -Body '{"input":{"type":"audio","audio":null},"output_mode":"text"}' } catch { $_.ErrorDetails.Message }
```

真实 provider 接入前，必须先通过 mock contract tests；不得在本地把真实 key 写入 `.env.example`、日志、测试 fixture 或 Postman。
