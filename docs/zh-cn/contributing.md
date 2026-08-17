---
title: 参与贡献
description: Issue、分支、提交、PR、评审、验证和双轨文档要求。
docId: crm.contributing
locale: zh-CN
audience: both
contentVersion: 0.1.0
---

先阅读根目录 `AGENTS.md` 和相关 ADR。提交实现前先搜索已有 issue 与 PR，并说明当前行为、期望行为、证据、风险和回滚。

新增 provider 类型、破坏性公开 schema、生命周期、信任边界或 Agent 能力需要 ADR。不得复制外部源码、prompt、fixture、客户资料或凭据。

PR 应保持单一职责，并包含问题和用户影响、契约或架构影响、测试证据、安全与数据影响、文档更新和回滚。CI 通过不能替代 CODEOWNERS 和人工验收。

提交主题使用命令式产品描述，例如 `docs: add MCP partner guide`。不要写 Agent 名称、工具签名、虚构批准或自动 co-author。

```powershell
pnpm run verify
pnpm run verify:mcp
```

`docs/` 同时服务 Web 和 MCP。翻译页面与英文页面共享稳定 `docId`；语言、受众和版本必须通过构建校验。
