---
title: 快速开始
description: 运行确定性参考服务，提交文本或 mock 音频请求，并验证生成的 CRM 事件。
docId: crm.quickstart
locale: zh-CN
audience: both
contentVersion: 0.1.0
---

```powershell
npm ci
npm test
npm run check
npm run build
npm start
```

服务默认监听 `http://localhost:8080`。先检查：

```powershell
Invoke-RestMethod http://localhost:8080/health/ready
```

提交文本请求：

```powershell
$headers = @{
  Authorization = 'Bearer local-actor'
  'X-Tenant-Id' = 'tenant_demo'
  'Idempotency-Key' = 'quickstart-001'
}
$body = @{
  input = @{ type = 'text'; text = '把 Acme renewal 移到 Negotiation' }
  output_mode = 'both'
  locale = 'zh-CN'
} | ConvertTo-Json -Depth 5
Invoke-RestMethod http://localhost:8080/v1/ask -Method Post -Headers $headers -ContentType 'application/json' -Body $body
```

返回 `completed` 只表示参考内存事务已提交。低置信度请求返回 `needs_review`，不得写 CRM。mock 音频要求 base64 内容解码后以 `MOCK_AUDIO:` 开头；没有真实音源时必须返回明确错误，不能生成虚假转写。

构建文档与 MCP 投影：

```powershell
npm run docs:build
npm run docs:preview -- --host 127.0.0.1 --port 4321
```
