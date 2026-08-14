---
title: 架构、模式与归属
description: 四平面架构、领域边界、关键模式、Agent 契约和失败隔离的中文概览。
docId: crm.architecture
locale: zh-CN
audience: both
contentVersion: 0.1.0
---

系统分为四个平面：交互平面接收文本、音频和输出偏好；智能平面负责 ASR、标准化、上下文检索和结构化理解；领域平面通过策略、CRM query/command、复核任务、事务和 outbox 管理业务真相；运营平面负责审计、事件、指标、trace、回放和发布。

Gateway 拥有身份、租户、限流、request ID 和幂等入口。ASR、Intent 和 TTS 是可替换 adapter；模型输出只是候选数据。Policy Decision Point 根据 RBAC、风险、置信度和确认状态决定只读查询、命令执行或人工复核。CRM Command Service 才能在事务中改变业务状态。

关键模式包括 Ports and Adapters、CQRS、transactional outbox、state machine、policy-as-code、幂等 consumer 和受控补偿。TTS 失败可以降级为文本；ASR 失败不能生成转写；意图不明确不能写数据；已提交 CRM 事务不会因为后续通知失败而静默回滚。

当前 `src/` 是确定性参考实现，使用内存存储和 mock provider。PostgreSQL、对象存储、OIDC 与真实 provider 是待验证的生产晋级工作，不是当前能力声明。完整图、bounded context 和 ownership rule 见英文 [Architecture](/architecture/)。
