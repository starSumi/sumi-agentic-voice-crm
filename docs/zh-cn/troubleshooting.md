---
title: 故障排查
description: 在保留证据的前提下诊断安装、运行时、契约、文档构建、MCP 投影和常见请求错误。
docId: crm.troubleshooting
locale: zh-CN
audience: both
contentVersion: 0.1.0
---

从第一个失败命令和退出码开始，保留 request ID、脱敏 trace 上下文和准确运行时版本。不能通过削弱校验来解决契约或授权失败。

| 现象 | 检查 | 安全处理 |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` 拒绝运行时 | `node --version`、`pnpm --version` 与 `.nvmrc` | 使用 Node `24.18.0` 或更高版本和 pnpm `10.33.4`。 |
| Astro 报 frontmatter 缺失 | 指向的 `docs/` 文件 | 补齐 title、docId、locale、audience 和 contentVersion。 |
| Web 有页面但 MCP 没有 | `astro.config.mjs` 映射 | 显式增加 source、machine 和 page 后重建。 |
| MCP URL 为 404 | routes map 与 `--base-url` | 对齐 machine path 和页面 route，并保留 base URL 尾部 `/`。 |
| 找不到 MCP server | `SUMI_DOCS_MCP_ENTRY` | 构建同级 Sumi-Docs-MCP 或指向其 `dist/index.js`。 |

`UNAUTHORIZED` 要求有效身份；`IDEMPOTENCY_CONFLICT` 要停止并核对原操作；`UNSUPPORTED_MEDIA` 要转换或重新采集；`EMPTY_TRANSCRIPT` 需要重录而不是猜测；`INTENT_LOW_CONFIDENCE` 必须进入人工复核；`ASR_TIMEOUT` 应在允许时沿用同一幂等上下文重试并检查 provider 与队列。

上报问题时附带命令、退出码、Node/pnpm 版本、脱敏响应、受影响文档或 endpoint、预期行为和回滚结果。禁止附带 token、客户音频、原始转写或敏感本地路径。
