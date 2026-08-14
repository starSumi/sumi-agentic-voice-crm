# ADR-0001：Agent-native voice CRM platform

**Status:** Accepted for implementation  
**Date:** 2026-08-14  
**Decision owner:** Sumi platform engineering  
**Scope:** text/voice CRM interaction, intent extraction, structured commands, optional TTS

## Context

传统 CRM 把 AI 当作聊天侧边栏，业务状态仍由表单和人工操作驱动。本项目把 agent 作为工作流编排者，但不能把自然语言推理等同于业务真相：模型会产生歧义、幻觉、重复调用和越权风险。语音又增加 MIME、时长、转码、空音源、ASR 质量、音频保留和 TTS provider 故障。

现有研究证据显示：Saathi 已有 ASR→结构化 CRM 输入链路；Northstar 已有 CRM 工具、事件投影、HITL 和测试组织；两者都没有完整 TTS、统一 `/ask`、企业身份/租户/HA 控制面。它们作为灵感而不是实现来源。

## Decision

采用四平面、contract-first、provider-neutral 架构：

1. Gateway 负责认证、租户、限流、request-id、幂等入口。
2. Ask Orchestrator 只编排，不直接写 CRM。
3. ASR、Intent、TTS 是可替换 adapter/service，拥有独立超时、模型版本和指标。
4. CRM Service 是唯一业务写权威，以 command + transaction + outbox 保障一致性。
5. 低置信度/高风险动作进入 durable ReviewTask。
6. 领域事件使用 CloudEvents 兼容 envelope，追踪使用 W3C trace context/OpenTelemetry 语义。
7. API 使用 OpenAPI 3.1；共享 schema 生成客户端、Postman 和 contract tests。
8. 默认 mock provider 保证离线可验证；生产 provider 通过 secret manager 和 capability health 接入。

## Alternatives rejected

| 方案 | 拒绝原因 |
| --- | --- |
| 在 Next.js route 中直接串接 ASR/LLM/DB/TTS | 边界和权限混杂，无法独立扩缩容/回放/审计 |
| 让 LLM 直接调用 SQL/CRM SDK | 绕过 schema、RBAC、幂等和事务 |
| 只依赖 AG-UI/聊天协议 | UI 事件不是 CRM 持久化契约，无法支持 API/批处理/审计 |
| 先写 CRM 再让用户确认 | 产生错误数据和不可逆副作用；改为 review/command gate |
| 把音频 base64 永久放在业务表 | 膨胀、泄漏、难以 TTL；使用私有对象存储引用 |

## Consequences

正面：服务边界清楚、可独立测试/替换 provider、可恢复和可审计、可支持文本/语音同一业务语义。代价：需要 schema、outbox、review queue、鉴权、观测和发布治理，初始代码量高于 showcase。

## Compatibility and migration

- Saathi Customer/Visit/Message 映射到 Customer/Activity/VoiceInteraction，保留 raw transcript 和 AI metadata。
- Northstar CrmState 映射到 CRM aggregates；全量 snapshot 仅作为迁移适配器，目标是 versioned query/events。
- 现有文本 CRM 调用可经 `/v1/ask` 进入；新语音功能不改变原业务 API 的安全边界。

## Rollback

按 image digest 回滚应用；数据库使用 expand/migrate/contract，不回滚已提交业务。TTS 可按 feature flag 关闭，保留文本回答；Intent 新版本失败时按 schema_version 路由上一版本。未消费 outbox/review/media 记录不可删除。

## Checkpoint

此 ADR 只有在 [CHECKPOINTS.md](CHECKPOINTS.md) 的 C0–C6 证据齐全后才能升级为生产批准。
