---
title: Sumi 智能语音 CRM
description: 面向运行、扩展、评审和 Agent 检索的契约优先语音 CRM 参考平台入口。
docId: crm.index
locale: zh-CN
audience: both
contentVersion: 0.1.0
---

Sumi 智能语音 CRM 是一个自有的文本与语音 CRM 工作流参考实现。它明确区分概率性理解和确定性业务状态：Agent 可以理解意图并提出操作，但授权、校验、策略、幂等、事务提交、审计和人工复核共同决定数据是否改变。

当前 `0.1.0` 使用确定性的 mock provider 和内存存储，适合探索契约和运行集成测试，不适合处理生产数据、真实客户音频或直接暴露到公网。

## 选择入口

| 目标 | 从这里开始 | 后续文档 |
| --- | --- | --- |
| 运行参考服务 | [快速开始](/zh-cn/quickstart/) | [配置](/zh-cn/configuration/) |
| 集成 API | [API 契约](/zh-cn/api/) | `contracts/openapi.yaml` |
| 理解状态归属 | [架构](/zh-cn/architecture/) | [生命周期](/lifecycle/) 与 [数据模型](/data-model/) |
| 评审安全控制 | [安全边界](/zh-cn/security/) | [事件与审计](/events-audit/) |
| 贡献代码或文档 | [开发](/zh-cn/development/) | [参与贡献](/zh-cn/contributing/) |
| 连接 AI 开发伙伴 | [Agent 指南](/zh-cn/agent-guide/) | [需求追踪](/traceability/) |
| 运行与恢复 | [运维](/zh-cn/operations/) | [故障排查](/zh-cn/troubleshooting/) |

## 当前已实现

- 用于文本和 mock 音频的 HTTP `/v1/ask`。
- 用于确定性 mock TTS 资产的 `/v1/tts/synthesize`。
- 请求边界上的租户、操作人和幂等校验。
- 结构化理解、低置信度复核、CRM 命令、审计和 outbox 示例。
- OpenAPI 3.1、事件、SQL migration、Postman、测试与可复现构建证据。
- 从同一套 `docs/` 生成的人类 Web 文档和 Sumi Docs MCP 投影。

## 尚未完成的生产目标

OIDC/JWKS、PostgreSQL RLS、私有对象存储、加密交互重放、OpenAI 兼容 provider、outbox worker、HTTP 指标和本地负载/故障演练已经实现。真实 provider 质量、安全专项、staging、签名制品、灾难恢复和生产批准仍是开放检查点。[发布就绪记录](/release-readiness/) 是当前状态的权威来源。
