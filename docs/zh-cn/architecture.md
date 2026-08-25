---
title: 架构、模式与归属
description: 四平面架构、领域边界、关键模式、Agent 契约和失败隔离的中文概览。
docId: crm.architecture
locale: zh-CN
audience: both
contentVersion: 0.1.0
---

## 产品控制哲学

Sumi 是声明式 Agent 控制平面，不是 Prompt 调用链。期望意图与观测现实彼此分离；事件负责
唤醒控制器，持久状态决定下一步。每类资源只有一个状态所有者，副作用必须幂等或受 CAS
保护，Ready 必须有当前 observed generation 对应的证据。

统一 generation/Condition envelope 适用于未来新增的公开声明式资源。现有内部控制面按
reconciled worker、state machine、governed lifecycle 或 CAS command 如实分类；进程扩展
和受管任务只允许显式重新准入，不会因健康失败自动重放。

`contracts/control-plane-policy.json` 是机器可读规范：声明意图而不是固定执行录屏；每次
副作用前重新观测；使用小型且所有权明确的控制器；按 at-least-once 设计；用 revision、
CAS、租约和 tenant scope 保护共享状态；授权、策略、预算和人工 checkpoint 先于执行；
终结必须有界且留下持久证据；模型输出始终只是未经信任的提案。完整决策见
[ADR-0007](adr-0007-declarative-agent-control-plane.md)。

系统分为四个平面：交互平面接收文本、音频和输出偏好；智能平面负责 ASR、标准化、上下文检索和结构化理解；领域平面通过策略、CRM query/command、复核任务、事务和 outbox 管理业务真相；运营平面负责审计、事件、指标、trace、回放和发布。

Gateway 拥有身份、租户、限流、request ID 和幂等入口。ASR、Intent 和 TTS 是可替换 adapter；模型输出只是候选数据。Policy Decision Point 根据 RBAC、风险、置信度和确认状态决定只读查询、命令执行或人工复核。CRM Command Service 才能在事务中改变业务状态。

关键模式包括 Ports and Adapters、CQRS、transactional outbox、state machine、policy-as-code、幂等 consumer 和受控补偿。TTS 失败可以降级为文本；ASR 失败不能生成转写；意图不明确不能写数据；已提交 CRM 事务不会因为后续通知失败而静默回滚。

当前 `src/` 同时提供确定性开发适配器和生产边界：PostgreSQL/RLS、OIDC/JWKS、私有 S3 兼容存储、加密 interaction、OpenAI 兼容 provider 与独立 outbox worker。真实环境连通性、模型质量、安全专项、staging 与人工发布批准仍需独立证据。完整图、bounded context 和 ownership rule 见英文 [Architecture](/architecture/)。

进程隔离扩展由 Rust 监督器持有一个 Linux 子进程组，并负责显式 ready 握手、正常关闭和有界强制终止；Node Control Engine 仍拥有编排、策略和业务 port。该生命周期协议不传递 CRM DTO 或秘密。
