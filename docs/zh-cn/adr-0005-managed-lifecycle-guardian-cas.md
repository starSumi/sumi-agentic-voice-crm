---
title: "ADR-0005：受管生命周期、Guardian 治理与会话 CAS"
description: 定义有界后台任务退出、Guardian 语义中断和会话状态乐观替换。
docId: crm.decision.0005-managed-lifecycle-guardian-cas
locale: zh-CN
audience: both
contentVersion: 0.1.0
---

**状态：** 已接受；运行时基础已实现
**日期：** 2026-08-17
**决策负责人：** Sumi 平台工程

## 决策

Control Engine 使用 `ManagedTaskRegistry` 统一拥有后台任务。每个任务只有
一个稳定名称、一个子 `AbortSignal`、一个被观察的结果，以及仅由可信监督器
提供的可选 terminate hook。关闭时先停止接收新任务，并发取消全部任务，默认
最多等待三秒。超时后只能要求受监督的独立进程退出，不能声称强杀任意进程内
JavaScript。

API 同时停止 HTTP 新连接并排空请求；到三秒边界时中止请求信号、关闭剩余
连接，再释放运行时资源。outbox 轮询循环是第一个纳入受管任务的后台工作。

Guardian 拒绝治理是 turn 级语义状态机，不是上游可用性熔断器。标准策略在
连续三次拒绝，或最近五十次审查中累计十次拒绝时中断；Cyber 策略首次拒绝
即中断。非拒绝只重置连续计数；已中断 turn 必须由所有者显式清理。状态受
最大数量和空闲 TTL 限制。

当前产品已有 CRM 写操作人工复核，但尚未部署网络、文件或命令权限的
Guardian adapter，因此不能声称自动权限审查已经接通。无传输绑定的协调器为
审查提供 90 秒协作期限和 2 秒受监督 hard-stop 宽限；超时、不可用或畸形输出
必须转人工并 fail closed，不能被解释为允许。

会话状态属于 runtime core。状态按租户加密保存为 JSON 对象，并带单调递增
revision。替换只能通过同时匹配
`(tenant_id, conversation_id, expected_revision)` 的单条数据库更新完成；陈旧
写入只得到冲突，不得到更新后的状态。HTTP、SSE、MCP、桌面端和 TUI 都必须
调用 `ConversationStateService`，不得直接更新表。

## 边界

- provider/outbox CAS 熔断器处理上游可用性；
- Guardian 拒绝窗口决定安全审查 turn 是否中断；
- 会话 revision CAS 防止并发状态覆盖；
- interaction lease 与 journal 负责请求执行恢复。

它们共享 CAS 思想，但不共享状态、阈值、失败含义或运维动作。

## 回滚

停止调用会话服务并保留新增表，旧镜像可继续运行。Guardian adapter 可独立
关闭而无需删除 governor。worker 只有在恢复同等的取消和退出所有权后，才可
退出 Managed Task 注册。
