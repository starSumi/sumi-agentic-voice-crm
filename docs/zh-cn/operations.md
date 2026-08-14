---
title: 运维手册
description: 健康信号、常见语音与 CRM 事故、安全操作和保留证据的恢复方式。
docId: crm.operations
locale: zh-CN
audience: both
contentVersion: 0.1.0
---

`/health/live` 只表示进程存活；`/health/ready` 在当前参考实现中报告 mock provider 状态，生产环境还必须覆盖 migration、数据库、对象存储、队列和 provider capability。`/v1/events` 仅用于本地诊断，生产需要运维权限、分页和审计。

| 现象 | 首要检查 | 安全操作 |
| --- | --- | --- |
| `ASR_TIMEOUT` | provider 延迟、队列、模型和 trace | 使用相同幂等上下文重试，保留媒体。 |
| `EMPTY_TRANSCRIPT` | 音频字节、时长、codec 和麦克风 | 请求重新录制，不写 CRM。 |
| `needs_review` 激增 | 模型版本、语言 WER、实体解析 | 暂停高风险命令 rollout，检查脱敏样本。 |
| 重复 CRM 记录 | 幂等存储、outbox 唯一性 | 停止 consumer，按 key 核对，禁止手工再插入。 |
| TTS 失败 | provider 和 voice capability | 保留文本响应，按任务策略重试 TTS。 |
| 事件积压 | relay lease、dead letter、数据库 | 扩容 relay，保持顺序并去重。 |

事故记录应包含 request ID、trace、受影响租户范围、已提交 aggregate version、outbox 状态和回滚或补偿决定，且不得包含原始客户敏感内容。
