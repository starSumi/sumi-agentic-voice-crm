---
title: 开发工作流
description: 仓库布局、本地命令、变更顺序、契约归属、测试要求和生成物边界。
docId: crm.development
locale: zh-CN
audience: both
contentVersion: 0.1.0
---

使用 Node.js `24.18.0` 或更高版本和 npm `11.15.0`。运行时是标准库 JavaScript；Astro 和 Starlight 只负责文档。

## 关键路径

| 路径 | 责任 |
| --- | --- |
| `src/` | HTTP 参考运行时、校验、provider 和内存状态。 |
| `contracts/` | OpenAPI 与事件协议权威来源。 |
| `db/` | 生产目标 schema 与 RLS migration。 |
| `docs/` | Web 与 MCP 共用的唯一评审内容源。 |
| `.agent/` | 版本化工程治理和检查点路由。 |
| `test/` | 运行时和契约回归测试。 |
| `artifacts/docs-site/` | 生成的站点和 `_mcp` 投影，不提交。 |
| `dist/` | 生成的运行时候选制品，不提交。 |

## 本地门禁

```powershell
npm ci
npm run verify
npm run verify:mcp
```

变更公开行为前先增加失败测试；先改规范类型或契约，再改 adapter 和 transport；模型输出始终是不可信输入；行为或运维流程改变时同步核心中英文文档。无法运行的门必须明确报告，不能用状态文档代替证据。
