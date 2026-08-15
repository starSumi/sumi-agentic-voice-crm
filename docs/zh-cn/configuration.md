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

开发默认使用内存数据库、development bearer、内存对象和 mock provider。`APP_ENV=production` 会强制 PostgreSQL、32 字节数据密钥、OIDC/JWKS、S3 兼容私有存储、三个 `openai-compatible` provider、HTTPS 公网地址和指标令牌；缺项即拒绝启动。独立 outbox worker 还要求投递 URL、租户列表和 HMAC secret。完整变量见 `.env.example`；配置通过不等于 staging 或生产批准。

文档构建使用 `DOCS_SITE_URL`，默认 `http://127.0.0.1:4321`。CI 部署时应设置为实际 HTTPS origin。`npm run docs:dev` 用于实时编写，`npm run docs:build` 把静态站和 `_mcp` 投影写入 `artifacts/docs-site/`。

禁止把 bearer token、API key、客户音频、原始转写或生产连接串写入示例、Markdown、测试和 Git 历史。
