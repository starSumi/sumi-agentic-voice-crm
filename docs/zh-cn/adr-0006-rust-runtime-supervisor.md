---
title: ADR-0006 Rust 运行时监督器
description: Linux 进程所有权、有界生命周期协议与 Node 控制面边界。
docId: crm.adr-0006
locale: zh-CN
audience: both
contentVersion: 0.1.0
---

## 决策

进程隔离扩展由 Rust 二进制 `sumi-runtime-supervisor` 持有。JavaScript
扩展注册表仍负责启动顺序与回滚；Rust 进程只负责一个子进程组及其操作系统生命周期。

内部协议 `sumi.runtime.supervisor.v1` 使用 NDJSON，每帧最多 64 KiB，规范位于
`contracts/runtime-supervisor.schema.json`。双方都校验协议版本、请求标识、操作字段、
绝对可执行路径、参数、环境、启动超时和关闭宽限期。

## 所有权边界

- 部署侧 Node resolver 决定绝对可执行路径和显式环境白名单，不继承宿主环境。
- 子进程必须在有界启动期限内输出 `sumi.runtime.extension.ready.v1`，否则启动失败。
- 正常关闭对整个子进程组发送 `SIGTERM`；宽限期到期后发送 `SIGKILL`。
- Linux parent-death signal 处理监督器崩溃窗口；Rust owner 被释放时也会终止并等待进程组。
- 首个纵切面只承载生命周期健康，不传递 CRM DTO、秘密、权限 port 或业务能力 RPC。

## 集成、回滚与验收

Node adapter 实现扩展注册表现有的 `start`、`health`、`stop` 和可信 `terminate`
契约。部署代码通过 composition root 的 `extensionRegistrations` 显式注册；默认列表为空，
应用加载或启动不会隐式发现可执行代码。发布构建把二进制复制到 `dist/bin`，并把可执行
位和摘要写入构建清单；容器以非 root 用户运行。回滚只需移除进程扩展注册或退回上一镜像，
不涉及数据库迁移或数据回滚。

验收必须包含 Rust 格式化、Clippy 零警告、Rust 单测、Node/Rust 互操作、闭合协议
Schema、构建清单、Docker smoke、依赖审计，以及精确提交的远程 CI。
