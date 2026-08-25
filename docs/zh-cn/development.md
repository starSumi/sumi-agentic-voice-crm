---
title: 开发工作流
description: 仓库布局、本地命令、变更顺序、契约归属、测试要求和生成物边界。
docId: crm.development
locale: zh-CN
audience: both
contentVersion: 0.1.0
---

使用 Node.js `24.19.0` 或更高版本和仓库固定的 `pnpm@10.33.4`。应用运行时是原生 ESM，并迁向 TypeScript 可擦除语法；Node 直接执行类型化模块，`typecheck:runtime` 提供静态门禁。pnpm 管理 JavaScript workspace，Nx 管理跨语言项目与任务图，Cargo 仍是 Rust 构建和依赖的权威工具。Astro 和 Starlight 只负责文档。

## 可选 Nix 开发环境

Linux 和 WSL2 开发者可以运行 `nix develop` 进入锁定的开发环境。该
flake 提供 Node 24、Git、jq、OpenSSL、Python、构建工具、PostgreSQL 17、
精确的 pnpm `10.33.4` 以及 Docker/Compose 客户端，但不会自动运行
`pnpm install`、启动 daemon、启动 Compose，也不会取代 pnpm lockfile 或 Docker 发布链路。

```bash
nix develop
pnpm install --frozen-lockfile
pnpm verify
pnpm run rust:check
```

`flake.lock` 固定 nixpkgs。更新它属于需要评审的依赖变更，必须同时运行
`nix flake check` 和原有 pnpm 验证门禁。

## 关键路径

| 路径                                            | 责任                                                                          |
| ----------------------------------------------- | ----------------------------------------------------------------------------- |
| `src/`                                          | HTTP 参考运行时、校验、provider 和内存状态。                                  |
| `packages/api-client/`                          | Workspace package；提供生成的传输投影和稳定 API/type facade。                 |
| `crates/runtime-supervisor/`                    | Linux 进程生命周期边界的 Cargo 与 Nx project。                                |
| `contracts/`                                    | OpenAPI 与事件协议权威来源。                                                  |
| `db/`                                           | 生产目标 schema 与 RLS migration。                                            |
| `docs/`                                         | Web 与 MCP 共用的唯一评审内容源。                                             |
| `orchestration/`                                | 版本化开发编排 desired state、schema 和 TypeScript 调度引擎；不进入产品制品。 |
| `.codex/`、`.agents/skills/sumi-orchestration/` | 生成的仓库工具 adapter；不含 live plan、对话、凭据或审批状态。                |
| `.agent/`、`.local/`                            | 已退役的旧路径和机器本地证据；Git、CI 和发布均忽略。                          |
| `test/`                                         | 运行时和契约回归测试。                                                        |
| `flake.nix`、`flake.lock`                       | 可选的 Linux/WSL2 开发环境，不替代发布或包管理链路。                          |
| `artifacts/docs-site/`                          | 生成的站点和 `_mcp` 投影，不提交。                                            |
| `dist/`                                         | 生成的运行时候选制品，不提交。                                                |

## 本地门禁

```powershell
pnpm install --frozen-lockfile
pnpm run workspace:projects
pnpm verify
pnpm verify:mcp
```

开始开发前读取 `AGENTS.md` 与相关契约或 ADR，并重新探测 Git 和 CI。变更公开行为前先增加失败测试；先改规范类型或契约，再改 adapter 和 transport；模型输出始终是不可信输入；行为或运维流程改变时同步核心中英文文档。无法运行的门必须明确报告，不能用本地状态代替证据。

每个传输边界只有一个语言中立规范源：公共 HTTP 使用 `contracts/openapi.yaml`，持久事件使用 `contracts/events.yaml`，本地 Node/Rust supervisor 使用 `contracts/runtime-supervisor.schema.json`。协议消费者必须运行 `pnpm run contract:consumer-check`：前端只能从
`@sumi/voice-crm-api-client/api` 导入操作、从 `@sumi/voice-crm-api-client/protocol` 导入类型，不能手写 `/v1/` 请求或
重复定义传输 DTO。`src/composition-root.ts` 负责进程级资源；请求、provider
操作和 PostgreSQL 事务的生命周期保持显式，provider 网络调用不持有数据库事务。
