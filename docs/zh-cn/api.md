---
title: API 契约
description: 身份、租户、幂等、请求模式、响应、错误以及 OpenAPI 权威边界。
docId: crm.api
locale: zh-CN
audience: both
contentVersion: 0.1.0
---

`contracts/openapi.yaml` 是 HTTP 协议的权威来源。本文用于阅读，客户端和测试应基于 OpenAPI 校验结构。

## 通用请求边界

`/v1/ask` 和 `/v1/tts/synthesize` 都要求：

- `Authorization: Bearer ...`：开发模式接受显式本地 token；生产模式通过远程 JWKS 验证 OIDC JWT 的签名、issuer、audience、subject、tenant 与配置 scope。
- `X-Tenant-Id`：必须来自已授权身份边界，不能从模型文本推断。
- `Idempotency-Key`：长度 8 到 128；同一个 key 配不同内容返回冲突。

## `POST /v1/ask`

支持 JSON 文本、JSON base64 音频或 multipart 音频。`output_mode` 为 `text`、`audio` 或 `both`。`200` 表示完成；`202` 表示需要人工复核且没有提交 CRM；`409` 表示幂等或版本冲突；`415` 表示不支持的媒体；`422` 表示输入结构合法但无法处理。

## `POST /v1/tts/synthesize`

输入文本、语言、可选 voice 和 `mp3`、`wav` 或 `ogg` 格式。参考响应只是有作用域的资产描述；生产实现必须使用私有存储、访问授权、过期时间和审计。

调用方必须依据错误 envelope 的 `retryable` 和操作语义决定重试。不能通过换一个幂等 key 绕过冲突。

健康检查、租户过滤事件视图和 mock 资产读取目前只用于本地验证，尚未进入公开 OpenAPI；在认证、分页、schema 和生命周期明确前，不应当作生产运维 API。
