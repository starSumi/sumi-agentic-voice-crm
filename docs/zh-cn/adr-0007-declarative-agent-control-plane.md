---
title: ADR-0007 声明式 Agent 控制平面
description: 为 Sumi Agent 采用控制器调和、显式所有权、持久真相与证据化收敛。
docId: crm.adr-0007
locale: zh-CN
audience: both
contentVersion: 0.1.0
---

**状态：** 已接受
**日期：** 2026-08-19
**决策所有者：** Sumi 平台工程

## 决策

Sumi 把长时间运行的 Agent 工作建模为声明式资源，并由小型、所有权明确的控制器持续调和。
意图表示期望状态，`status` 只描述控制器观察到的实际状态。事件、队列通知、watch 和定时器
只负责唤醒；控制器在产生副作用前必须重新读取权威状态。

规范源为 `contracts/control-plane-policy.json`。Schema 与 CI 校验器要求每类资源只有一个
状态写入者、采用 level-triggered 决策和 at-least-once 交付，副作用必须幂等或受 CAS 保护，
租约必须过期，终结必须有界，并且只有当前代际的证据才能支撑 Ready 或 Verified。

统一的 `generation`、`observed_generation` 和 Condition envelope 是未来新增公开声明式资源的
强制契约。现有 interaction、extension、Guardian 和 managed-task 内部状态机继续使用各自
版本化状态，直到经过明确迁移。策略会记录每个控制面的真实 mode、version fence、恢复范围
和验证测试，不能把迁移写成已完成。

该模型采用 Kubernetes 官方[控制器模式](https://kubernetes.io/docs/concepts/architecture/controller/)
和 [API conventions](https://github.com/kubernetes/community/blob/main/contributors/devel/sig-architecture/api-conventions.md)
中的控制循环与 `spec/status` 分离原则，但 Sumi 不因此依赖 Kubernetes，也不会把 Kubernetes
资源当作产品 API。

## Sumi 的 Agent 语义

- 模型输出是不可信提案，不是权威业务状态。
- 服务端策略和事务内 PEP 才拥有授权决定权。
- 不可逆副作用必须经过显式策略或人工复核。
- 完成必须由当前 Condition 和持久证据共同证明，不能由进程退出或模型自述决定。
- 每个 run 都有 deadline、attempt 和 cost 预算。
- 并发替换使用版本化 CAS；已经提交的外部副作用使用补偿，而不是假装总能回滚。
- 隐藏推理不是审计证据；可审计记录是输入、决策、策略版本、副作用和制品摘要。

## 资源与控制器边界

消息任务、interaction、扩展、outbox 事件、会话状态、受管任务和 Guardian turn 均只有一个
声明的状态所有者。其他组件可以请求工作或消费投影，但不能直接写入这些资源的状态。
PostgreSQL 持久状态、验证后的扩展注册表或 managed-task registry 才是真相；SSE、
CloudEvents 和进度通知只是投影与唤醒提示。

租约只授予临时工作所有权，并且必须过期；过期 owner 不能提交。终结阶段负责释放租约、
排空任务、记录终态，或在有界时间内请求可信监督器终止进程。这对应 Kubernetes
[Lease](https://kubernetes.io/docs/concepts/architecture/leases/) 与
[finalizer](https://kubernetes.io/docs/concepts/overview/working-with-objects/finalizers/) 的目的，
但不复制其线协议。

## 后果与回滚

控制器必须容忍重复或缺失的唤醒、进程重启、乱序观察和重试。新增控制器必须在机器可读策略中
声明实现路径、真相来源、并发保护、幂等键、终结行为和状态证据。只依赖事件流、无界关闭或
多写者状态会被架构门禁拒绝。

消息任务与 outbox 当前采用有界指数退避；在水平扩展竞争 worker 前必须补齐 jitter。扩展和
受管任务采用 `explicit-only` 重启策略：健康失败可以影响 status 与 readiness，但不能自动
重放副作用未知的工作。

该策略不要求一个万能调度器或单体控制器。Control Engine 持有共享生命周期原语，应用控制器
继续持有各自领域状态机与事务边界。移除策略与校验器不需要数据迁移，但不能连带移除运行时
CAS、租约、WAL、授权、复核或受管 teardown。
