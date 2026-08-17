---
title: "ADR-0004：运行时核心、Agent 平面与客户端适配器"
description: 为 Web、桌面端、TUI、MCP 和 AG-UI 定义与传输无关的运行时边界。
docId: crm.decision.0004-runtime-agent-boundary
locale: zh-CN
audience: both
contentVersion: 0.1.0
---

**状态：** 已接受，正在渐进迁移
**日期：** 2026-08-16
**决策 owner：** Sumi 平台工程

## 决策

Sumi 分为两个服务端平面和多个薄客户端适配器：

1. **运行时核心**负责认证上下文、租户隔离、幂等、应用服务、附件生命周期、持久化事务、审计、outbox、持久领域事件和读模型。它不导入 UI、MCP SDK、provider SDK 或 Node HTTP 请求/响应对象。
2. **Agent 平面**负责模型交互、provider 选择、意图归一化、工具选择、安全策略和复核请求。Agent 输出在运行时核心验证和授权前均视为不可信。
3. **适配器**为 HTTP/OpenAPI、SSE 或 AG-UI、MCP 工具/资源、桌面端、TUI 和未来内部 IPC 投影同一套应用服务。适配器可以翻译 envelope 和流式事件，但不能直接写 CRM 状态，也不能绕过复核、审计、幂等或 outbox。

浏览器不是控制平面。前端 registry 只能注册视图组件和状态投影；权限和能力注册必须留在服务端。

## 状态与事件

持久状态使用扁平记录，并通过不透明 ID 关联：`run/interaction`、`step`、`attachment`、`review`、`command` 和 `event`。CloudEvents 与事务 outbox 是持久业务流；临时 UI 事件只是投影，不能当作 CRM 真相或审计日志替代品。

所有媒体和未来的非文本输入都通过附件引用边界：租户、不透明 asset ID、MIME、字节数、内容哈希、存储 key、状态、过期时间和授权元数据。原始音频或大载荷只能出现在已认证的入口或 provider 边界；事件和 UI snapshot 只携带引用、摘要和哈希。

应用服务可以通过可选 event sink 发出有界的进度里程碑，但不得发出隐藏思维链、prompt、凭据、签名 URL 查询参数、原始转录或客户实体。

## 传输选择

- HTTP/OpenAPI 继续作为当前 Web 客户端和生成 SDK 的命令/查询契约。
- SSE 作为浏览器进度的默认增量投影。AG-UI 适配器是附加层，调用同一应用服务，不替代 OpenAPI、CloudEvents、PostgreSQL 或 outbox。
- MCP 是 Agent 工具和文档资源的扩展边界。未来 CRM MCP server 必须是应用服务的薄适配器，并显式映射租户、actor、scope 和幂等。文档 MCP 继续只读，和 CRM mutation 工具分离。
- gRPC 留给未来真正拆分后的内部服务。现在引入会制造第二套传输/ schema 面，并需要浏览器 gateway。WebSocket 只在确实需要双向低延迟媒体或控制时引入；普通进度不需要它。

## Protocol 与 API 方向

即使当前由同一个 workspace package 承载，Protocol 与 API 也是两个依赖边界。`@sumi/voice-crm-api-client/protocol` 只导出数据和事件类型；`@sumi/voice-crm-api-client/api` 负责 HTTP 操作、client 配置、transport error、timeout 和认证 header。根入口只保留兼容聚合。两者仍由同一份 OpenAPI 和 event contract 生成，拆包不能产生第二套 DTO 真相源。

系统有两条不能混淆的 API 方向：Web、desktop、TUI 消费 Sumi 入站 API，而服务端 application core 实现合同，不反向调用自己的 HTTP client；Agent plane 调用外部模型 API 时，先构造供应商无关的内部 item，由 provider adapter 映射为 OpenAI Responses、DashScope 或本地模型请求，再把 HTTP/SSE provider event 映射回内部 Agent event，最后才能更新会话状态。

`ResponsesApiRequest` 等供应商专属类型必须留在对应 adapter。只有在 Sumi 明确定义 schema、顺序、兼容和脱敏规则后，`ResponseItem`、`ContentItem`、`TurnItem` 才能进入共享 protocol。SQ/EQ 目前不是 Sumi 合同术语，不能凭空加入。

当前生成客户端只实现请求/响应式 HTTP 操作与 client 配置，尚未提供供应商无关的 Responses SSE parser。只有在事件顺序、取消、续传、错误和兼容合同完成评审后，parser 才进入 API/provider adapter；application core 只消费映射后的内部事件流。

## 扩展与插件边界

Provider adapter、MCP server 和 UI projection 都是扩展，但运行时不加载任意第三方代码。当前 manifest 已固定精确版本、协议版本、owner、隔离模式、capability、permission、dependency 与 entrypoint；registry 按依赖启动、逆序停止，以部署 allowlist 和受信 ID 控制权限，并只传 permission-scoped ports。

`process` 只有在受信 deployment launcher 确实创建并监管子进程时才构成隔离；manifest 和 `terminate()` 本身不是 OS sandbox。registry 不动态 import entrypoint，也不向扩展传完整环境变量。Control Engine 统一管理 epoch-aware CAS 熔断与生命周期：10 秒软超时发出协同取消，再给 2 秒清理窗口；只有受监管进程才具备真实 hard kill。`.mcp.json` 只是注册文件，不授予权限。

## 后果与回滚

第一阶段抽取 Ask、TTS、Review 服务到显式 ports，随后加入进度 sink 和附件 schema。桌面端、TUI 和 CRM MCP 可以复用业务逻辑，不需要复制。代价是额外的内部 command/result 模型；这是有意的，因为传输 envelope 与领域状态的生命周期不同。

停用新的 adapter 或扩展注册即可回滚。现有 HTTP/OpenAPI、PostgreSQL、审计、outbox 和文档 MCP 继续可用；临时 UI 投影不需要数据库回滚，持久 schema 仍遵循迁移和恢复门禁。
