---
title: 国际化与内容身份
description: 语言元数据、翻译配对、回退行为、MCP 兼容策略和评审要求。
docId: crm.localization
locale: zh-CN
audience: both
contentVersion: 0.1.0
---

国际化首先是内容契约，不只是语言按钮。每个发布的 Markdown 文件声明稳定 `docId`、BCP 47 `locale`、受众和内容版本。同一篇文档的不同语言共享 `docId`，人和 Agent 不需要根据文件名猜翻译关系。

当前支持 `en` 和 `zh-CN`。`audience` 可为 `human`、`agent` 或 `both`，它描述主要用途而不是访问控制。`contentVersion` 是项目内容版本，不是 manifest schema 版本。

Sumi manifest v1 保持 `documents: string[]`，避免破坏旧客户端。语言元数据位于 frontmatter，可通过 `fetch_doc` 取得。未来结构化 manifest 必须使用新 schema 版本，不能把 v1 字符串原地替换成对象。

核心上手、配置、API、Agent、贡献和故障排查文档维护中英文版本；深度工程记录可暂时回退到英文，并显示未翻译提示。自动翻译只能形成草稿，成为发布证据前必须经过自有评审。
