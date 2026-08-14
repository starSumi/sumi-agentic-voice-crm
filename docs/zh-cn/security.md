---
title: 安全与信任边界
description: 租户隔离、prompt 和媒体威胁、授权、隐私、审计、幂等和人工确认控制。
docId: crm.security
locale: zh-CN
audience: both
contentVersion: 0.1.0
---

主要风险包括跨租户访问、客户内容中的 prompt injection、重试造成重复命令、恶意或伪造音频、provider/key 泄露、转写和日志泄露、TTS 滥用以及不安全媒体 URL。

生产边界要求：Gateway 验证 OIDC/JWT；租户来自授权身份而不是模型文本；所有查询强制租户谓词；工具和命令使用 allowlist 与严格 schema；写操作经过 RBAC、风险、置信度、确认、幂等和乐观版本控制；事件 consumer 按 ID 去重；媒体校验 magic byte、codec、时长和大小并使用私有存储；日志默认脱敏；密钥通过工作负载身份或密钥管理系统注入。

高风险操作必须显式人工确认。TTS 回答不能在事务提交和审计事件之前声称成功。参考运行时的 bearer 字符串检查和内存租户过滤只用于测试，不等于生产身份与隔离已经验证。
