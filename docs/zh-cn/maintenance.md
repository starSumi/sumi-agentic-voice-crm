---
title: 维护者与会话连续性
description: 项目维护的责任归属、评审后的交接游标、外部运行态、CI 运维和恢复流程。
docId: crm.maintenance
locale: zh-CN
audience: both
contentVersion: 0.1.0
---

本项目把持久的项目事实与短期 agent 运行态分开。这样既能审查和回滚交接信息，也不会把会话记录、锁、重试、凭据或机器路径提交到 Git。

## 状态归属

| 状态 | 位置 | 生命周期 |
| --- | --- | --- |
| 角色、阶段/检查点策略、维护者、评审后的交接游标 | `.agent/` | 随项目版本化并接受评审。 |
| 当前会话 ID、agent 关系、重试、锁和临时证据 | 依次使用 `CODEX_HOME`、`XDG_STATE_HOME`、平台本地应用数据目录 | 机器本地状态；`npm run agent:resume` 会输出实际路径，`.agent-runtime/` 只作为显式后备。 |
| CI 观察快照 | Actions 中的 `agent-operations-<run-id>` artifact | 每次运行生成，保留 30 天。 |
| 需要人工关注的 CI 异常 | 标题为 `[CI Operations] main requires attention` 的唯一 Issue | 失败时创建或更新，主分支恢复后关闭。 |

`.agent/.agent.cursor.json` 是经过评审的交接点，不是实时会话数据库。它可以记录 commit、阶段、检查点、未完成工作、外部阻塞和下一项安全动作，但不能包含 prompt、聊天记录、token、PID 或短期的 `running`/`waiting` 状态。

## 维护角色

`.agent/.agent.maintainers.json` 维护文档、连续性和 CI 运维的责任，`CODEOWNERS` 把相同范围路由给仓库所有者。`npm run agent:health` 校验责任记录、评审周期和控制面一致性。

- `docs-maintainer` 保持人类 Web 页面与 `_mcp` 投影一致。
- `continuity-supervisor` 维护评审后的游标，只恢复稳定的 agent 关系。
- `ci-operations-agent` 观察 CI 并维护运维 Issue；它不能修改源码、批准检查点、发布、打 tag 或部署。

## 当前与下一个会话

进入仓库后先执行：

```powershell
git status --short --branch
npm run agent:health
npm run agent:resume
```

然后阅读 `AGENTS.md`、manifest、state、cursor 和当前检查点卡，并重新探测 Git 和 CI。运行态中的 agent 关系只使用 `open` 或 `closed`；进程停止不等于委派已经关闭。

交接时，只在持久事实变化后更新版本化 cursor，再原子写入本地会话快照：

```powershell
npm run agent:resume -- --agent "/root=open" --agent "/root/reviewer=closed"
```

命令会输出运行态文件位置，默认位于 Git 仓库之外。

## CI 运维

`operations-agent` workflow 观察 `main` 上完成的 `ci`，每周检查漂移，也支持手工触发。观察 job 只有只读仓库权限；独立的协调 job 只有 `issues: write`，不会 checkout 或执行项目脚本。

workflow 把上游结论、commit、控制面健康、验证结果和发布冻结状态写入 JSON artifact 与 Actions summary。失败时更新一个固定 Issue，恢复时关闭同一 Issue。自动化报告不能替代发布证据，也不能解除人工验收门。

## 恢复

本地快照丢失或损坏时，只删除对应 thread 的外部 operations 目录，再运行 `npm run agent:resume`。版本化 cursor 是恢复来源。治理变更有误时应 revert 对应的独立 commit，不能把运行时历史写回 `.agent/`。

当前 GitHub 方案不能为这个私有仓库启用预期的分支保护。仓库继续保持私有，CI 成功只作为证据，不作为批准。
