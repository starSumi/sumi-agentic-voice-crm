---
title: Agent 开发伙伴指南
description: 连接 Sumi Docs MCP，发现项目，回答有证据的问题，并在 CRM 安全边界内修改代码。
docId: crm.agent-guide
locale: zh-CN
audience: agent
contentVersion: 0.1.0
---

这套文档面向没有历史上下文的 AI 开发伙伴。先通过 MCP 获取产品和架构信息，再用当前 checkout 的契约、源码和测试确认可变实现事实。

## 本地连接

```shell
pnpm run docs:build
pnpm run docs:preview -- --host 127.0.0.1 --port 4321
sumi-docs-mcp serve docs \
  --openapi protocol/schema/json/openapi.bundle.json
```

loopback HTTP 只用于开发，部署后必须使用 HTTPS。

## 推荐发现顺序

1. 用 `list_docs` 获取语料清单和人类页面 URL。
2. 用 `search_docs` 搜索 `idempotency`、`低置信度`、`tenant`、`outbox` 或 `ASR_TIMEOUT` 等具体术语。
3. 用 `fetch_doc` 获取最相关文档，并读取 `docId`、`locale`、`audience` 和 `contentVersion`。
4. 修改请求或响应前先调用 `get_openapi_spec`。
5. 写代码前回到 `src/`、`contracts/`、migration 和测试核实当前行为。

有 checkout 时还应运行 `pnpm run agent:health` 和 `pnpm run agent:resume`，然后读取 `.agent/.agent.cursor.json` 与当前检查点卡。cursor 只是经过评审的交接信息，使用前仍要核实其中的 commit 与 CI 状态。搜索 `continuity-supervisor` 或获取 `zh-cn/maintenance.md` 可以看到完整的当前/下一会话流程。

## 证据优先级

OpenAPI 与事件契约是协议权威；`RELEASE-READINESS` 决定哪些门真正通过；`SOURCE-EVIDENCE` 区分源码确认、运行观察、推断和未知；`.agent/` 负责任务和检查点路由，但不能替代源码或运行证据。

任何自然语言输出都不能直接修改 CRM。写操作必须具备授权租户和操作人、严格 schema、风险策略、幂等、事务、审计和 outbox。低置信度必须创建复核任务。

`pnpm run verify:mcp` 会通过真实 stdio MCP 请求验证四个工具和代表性开发问题，而不是只相信文档描述。
