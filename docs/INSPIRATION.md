# 灵感来源与非抄袭声明

本实现的设计灵感来自两个已研究的开源项目：

- `JagadeepPortfolio/saathi-crm`：语音录入、whisper.cpp ASR、结构化客户/访问记录、媒体签名 URL、provider adapter。
- `CopilotKit/CopilotKit/examples/showcases/strands-crm`（Northstar）：CRM 工具边界、Strands agent、AG-UI 事件、SQLite 状态投影、HITL 和测试组织。

参考方式是阅读源码后重新抽象问题边界；本仓库没有复制其源码、文档段落、截图、seed 数据、提示词或密钥。目标契约、命名、事件模型、所有权、审计、检查点和发布链由 Sumi 重新设计。

证据固定：Saathi `693ec2bd20e546a06238559cc4cb20e342080af2`；Northstar checkout `2328062960a1e9b4b8bc2eb2817724fc624f8785`。它们是比较证据，不是 Sumi 运行时依赖。
