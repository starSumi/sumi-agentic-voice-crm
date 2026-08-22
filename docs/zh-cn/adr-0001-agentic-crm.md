---
title: "ADR-0001：Agent 原生语音 CRM 平台"
description: 文本与语音 CRM 编排、安全边界、归属和回滚的已接受架构决策。
docId: crm.decision.0001-agentic-crm
locale: zh-CN
audience: both
contentVersion: 0.1.0
---

**状态：** 已接受实现

**日期：** 2026-08-14

**决策负责人：** Sumi 平台工程

**范围：** 文本与语音 CRM 交互、意图提取、结构化命令和可选 TTS

## 背景

传统 CRM 把 AI 当作聊天侧边栏，业务状态仍由表单和人工操作驱动。本项目把 Agent 作为工作流编排者，但不能把自然语言推理等同于业务真相：模型会产生歧义、幻觉、重复调用和越权风险。语音又增加 MIME、时长、转码、空音源、ASR 质量、音频保留和 TTS provider 故障。

## 决策

采用四平面、contract-first、provider-neutral 架构：

1. Gateway 负责认证、租户、限流、request ID 和幂等入口。
2. Ask Orchestrator 只编排，不直接写 CRM。
3. ASR、Intent、TTS 是可替换 adapter 或 service，拥有独立超时、模型版本和指标。
4. CRM Service 是唯一业务写权威，以 command、transaction 和 outbox 保障一致性。
5. 低置信度或高风险动作进入持久化 `ReviewTask`。
6. 领域事件使用 CloudEvents 兼容 envelope，追踪使用 W3C Trace Context 和 OpenTelemetry 语义。
7. API 使用 OpenAPI 3.1；共享 schema 用于生成客户端、Postman 和契约测试。
8. 默认 mock provider 保证离线可验证；生产 provider 通过密钥管理和 capability health 接入。

## 被拒绝的替代方案

| 方案 | 拒绝原因 |
| --- | --- |
| 在 Next.js route 中直接串接 ASR、LLM、数据库和 TTS | 边界和权限混杂，无法独立扩缩容、回放和审计 |
| 让 LLM 直接调用 SQL 或 CRM SDK | 绕过 schema、RBAC、幂等和事务 |
| 只依赖 AG-UI 或聊天协议 | UI 事件不是 CRM 持久化契约，无法覆盖 API、批处理和审计消费者 |
| 先写 CRM 再让用户确认 | 产生错误数据和不可逆副作用；应使用复核和命令门 |
| 把音频 base64 永久放在业务表 | 数据膨胀、泄漏风险和 TTL 困难；应使用私有对象存储引用 |

## 后果

收益是服务边界清楚、provider 可独立测试和替换、可恢复、可审计，并让文本和语音共享业务语义。代价是需要 schema、outbox、复核队列、鉴权、观测和发布治理，初始工作量高于 showcase。

## 兼容与迁移

- 现有文本 CRM 调用可经 `/v1/ask` 进入；语音能力不改变原业务 API 的安全边界。
- 外部数据只能通过显式版本化 adapter 映射为 Customer、Activity 和
  VoiceInteraction aggregate；导入 snapshot 不能成为运行时业务事实来源。

## 回滚

应用按 image digest 回滚；数据库使用 expand、migrate、contract，不回滚已提交业务。TTS 可以由 feature flag 关闭并保留文本回答；Intent 新版本失败时按 `schema_version` 路由到上一兼容版本。不得删除未消费的 outbox、review 和 media 记录。

## 发布验收

实现验收不等于生产授权。升级必须通过构建与发布文档定义的 staging、安全、
回滚、制品和人工审批门禁。
