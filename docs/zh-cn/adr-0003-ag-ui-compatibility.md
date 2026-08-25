---
title: "ADR-0003：AG-UI 兼容边界"
description: 在不替代 CRM 持久契约的前提下暴露 AG-UI 的决策与引入门禁。
docId: crm.decision.0003-ag-ui-compatibility
locale: zh-CN
audience: both
contentVersion: 0.1.0
---

**状态：** 已接受；在出现真实 AG-UI 消费端之前暂不加入运行时依赖
**日期：** 2026-08-16
**决策责任人：** Sumi 平台工程
**范围：** 可选的 agent-to-UI 流、工具可见性、UI 状态投影和人工确认展示

## 当前边界

Sumi 当前提供同步 OpenAPI `/v1/ask`、持久 ReviewTask、私有音频资产和租户隔离
CloudEvents。`/v1/events` 返回的是持久领域事件，不是 AG-UI SSE 流；当前 `ask`
编排仍与 Node HTTP request/response 耦合。

## 决策

1. OpenAPI command、ReviewTask、PostgreSQL transaction、audit、outbox 和
   CloudEvents 继续作为业务事实来源。
2. 不为包装现有最终 JSON 响应而直接加入 AG-UI 包；那只会增加第二套 transport
   契约，却没有真实 streaming 或前端工具执行收益。
3. 选定真实 AG-UI 消费端后，先把 `/v1/ask` 抽成与 transport
   无关的 application service，再增加调用同一服务的可选认证 `/v1/ag-ui` adapter。
4. adapter 可以发送 `RUN_STARTED`、有界 step/activity、assistant text、租户隔离
   UI 投影以及 `RUN_FINISHED`/`RUN_ERROR`，但不能暴露隐藏思维链，也不能把
   AG-UI state snapshot 当作 CRM 持久状态。
5. 前端 tool result 不能绕过授权、schema、幂等、策略、ReviewTask、transaction、
   audit 或 outbox。
6. 语音输入继续使用有界 `/v1/ask` media 契约；生成语音只通过私有短期 asset
   引用或命名 custom event 表示，不能把客户原始音频塞进 state snapshot。
7. 启用前必须精确固定 AG-UI 包版本，并覆盖事件顺序、断连、取消、租户隔离与
   兼容性测试。

## 引入门禁

只有以下条件全部满足时才引入 adapter：

- 已确定前端消费端和需要增量输出、工具可见性、generative UI 或交互恢复的用户旅程；
- application service 重构避免复制 `/v1/ask` 业务逻辑；
- 在选定反向代理后验证 SSE abort、timeout、backpressure 和 client disconnect；
- 明确 `threadId`、`runId`、request ID、tenant、actor 和 idempotency 的关联与 replay 策略；
- ReviewTask 仍持久且 fail-closed；
- 原有 OpenAPI、CloudEvents、audit、outbox 和 rollback 门禁继续通过。

## 结果

项目保留 AG-UI 的高价值选择权，但在没有消费端时不承担运行时和兼容成本。未来
adapter 是可增加、可回退的投影层；API、batch、audit 和 worker 消费者不需要理解
AG-UI。

## 回滚

禁用或删除 `/v1/ag-ui` 及其依赖即可。AG-UI state/message 只是投影，不需要数据库
回滚；现有 OpenAPI 和 CloudEvents 消费端不受影响。
