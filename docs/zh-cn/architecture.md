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

当前 `src/` 同时提供确定性开发适配器和生产边界：PostgreSQL/RLS、OIDC/JWKS、私有 S3 兼容存储、加密 interaction、OpenAI 兼容 provider 与独立 outbox worker。真实环境连通性、模型质量、安全专项、staging 与人工发布批准仍需独立证据。完整图、bounded context 和 ownership rule 见英文 [Architecture](/architecture/)。

进程隔离扩展由 Rust 监督器持有一个 Linux 子进程组，并负责显式 ready 握手、正常关闭和有界强制终止；Node Control Engine 仍拥有编排、策略和业务 port。该生命周期协议不传递 CRM DTO 或秘密。
