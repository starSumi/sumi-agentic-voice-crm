---
title: 配置
description: 运行时与文档设置、默认值、密钥边界，以及开发环境和生产环境的差异。
docId: crm.configuration
locale: zh-CN
audience: both
contentVersion: 0.1.0
---

当前 `npm start` 不会自动读取 `.env`。PowerShell 可用 `$env:NAME = "value"` 设置当前进程变量；生产环境应由部署平台或密钥管理系统注入。

## 当前真正生效的变量

| 变量 | 默认值 | 当前作用 |
| --- | --- | --- |
| `PORT` | `8080` | HTTP 监听端口。 |
| `PROVIDER_MODE` | `mock` | 出现在 readiness 响应中；目前只有 mock 行为。 |
| `ASR_PROVIDER` | `mock` | 仅报告名称，尚无动态 provider 加载。 |
| `INTENT_PROVIDER` | `mock` | 仅报告名称，尚无动态 provider 加载。 |
| `TTS_PROVIDER` | `mock` | 仅报告名称，尚无动态 provider 加载。 |

`.env.example` 中的 `APP_ENV`、数据库、对象存储、JWT 和 OpenAI 变量描述后续晋级边界，当前参考运行时尚未消费。占位符存在不等于生产集成已经完成。

文档构建使用 `DOCS_SITE_URL`，默认 `http://127.0.0.1:4321`。CI 部署时应设置为实际 HTTPS origin。`npm run docs:dev` 用于实时编写，`npm run docs:build` 把静态站和 `_mcp` 投影写入 `artifacts/docs-site/`。

禁止把 bearer token、API key、客户音频、原始转写或生产连接串写入示例、Markdown、测试和 Git 历史。
