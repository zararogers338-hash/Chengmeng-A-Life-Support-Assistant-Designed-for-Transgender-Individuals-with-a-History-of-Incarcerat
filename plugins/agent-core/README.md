# Chengmeng Agent 预设

通过 DeepSeek Harness 原生 Agent/Persona 扩展注册 `chengmeng` 预设。显示名来自 `config/agent.json`；完整提示词由 `persona/persona.md` 和 `persona/reply-style.md` 构建，记忆使用协议置于前部。

```powershell
node plugins/agent-core/scripts/build.mjs
node plugins/agent-core/scripts/build.mjs --check
```

工具策略仅开放宿主实际注册的支持能力：记忆状态、整理记忆、聊天历史、资料与技能，以及文件读取/修改、图片、命令和网络工具。平台或宿主缺少某项能力时不会伪造对应工具。

本模块负责预设和工具策略，记忆的存储、归档和检索由 `memory-consent` 模块实现。当前桌面整合包默认使用自动记忆模式。

修改提示词后重新构建，再用新会话验证；旧会话可能保留创建时的预设。较长提示词会占用模型上下文，完整加载不等于每次回答行为必然正确。

桌面版安装见 [项目首页](../../README.md)，开发与打包见 [构建指南](../../desktop/BUILD.md)。
