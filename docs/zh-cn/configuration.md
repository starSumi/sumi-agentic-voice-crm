---
title: 配置
description: 运行时与文档设置、默认值、密钥边界，以及开发环境和生产环境的差异。
docId: crm.configuration
locale: zh-CN
audience: both
contentVersion: 0.1.0
---

当前 `pnpm start` 不会自动读取 `.env`。PowerShell 可用 `$env:NAME = "value"` 设置当前进程变量；生产环境应由部署平台或密钥管理系统注入。

## 当前真正生效的变量

开发默认使用内存数据库、development bearer、内存对象和 mock provider。`APP_ENV=production` 会强制 PostgreSQL、32 字节数据密钥、OIDC/JWKS、S3 兼容私有存储、HTTPS 公网地址和指标令牌；`ASR_PROVIDER`、`INTENT_PROVIDER`、`TTS_PROVIDER` 必须分别选择 `openai-compatible` 或 `dashscope`，可以混用，生产环境拒绝 `mock`。缺项即拒绝启动。独立 outbox worker 还要求投递 URL、租户列表和 HMAC secret。

`openai-compatible` 使用 `OPENAI_API_KEY`、HTTPS `OPENAI_BASE_URL`，用于意图识别时还必须显式设置 `OPENAI_MODEL`。TTS 的公共 `voice=default` 映射到 `OPENAI_TTS_VOICE`（默认 `alloy`），公共 `format=ogg` 映射为供应商的 `opus` 响应格式。`dashscope` 使用 `DASHSCOPE_API_KEY` 和 HTTPS `DASHSCOPE_BASE_URL`；默认模型是 `qwen-plus`、`qwen3-asr-flash`、`qwen3-tts-flash`，默认声音为 `Cherry`。Qwen TTS 当前只接受 WAV 输出，ask 流程会自动采用该 adapter 的默认格式。为避免超过官方 512-token 上限又静默拼接音频，adapter 使用保守的 512 字符预检；超长文本和不支持的 locale 返回 `INVALID_REQUEST`。签名音频下载逐跳校验 HTTPS、官方 OSS 主机、重定向、大小和 magic bytes；`DASHSCOPE_TTS_MAX_BYTES` 默认 10 MiB。`PROVIDER_SOFT_TIMEOUT_MS` 默认 10 秒，触发协同取消；`PROVIDER_HARD_GRACE_MS` 默认再等待 2 秒，只有受监管子进程才能执行真实 hard kill。`PROVIDER_TIMEOUT_MS` 仅作为旧部署兼容 fallback。`INTERACTION_LEASE_MS` 默认 30 秒；provider 音频上限为 50 MiB。

现有环境变量 `ALIYUN_BASE_APIKEY`、`ALIYUN_BASE_URL`、`ALIYUN_BASE_MODEL` 及对应 ASR/TTS 变量继续作为兼容别名；两套同时存在时优先 `DASHSCOPE_*`。完整变量见 `.env.example`；配置通过不等于 staging 或生产批准。

文档构建使用 `DOCS_SITE_URL`，默认 `http://127.0.0.1:4321`。CI 部署时应设置为实际 HTTPS origin。`pnpm run docs:dev` 用于实时编写，`pnpm run docs:build` 把静态站和 `_mcp` 投影写入 `artifacts/docs-site/`。

禁止把 bearer token、API key、客户音频、原始转写或生产连接串写入示例、Markdown、测试和 Git 历史。
