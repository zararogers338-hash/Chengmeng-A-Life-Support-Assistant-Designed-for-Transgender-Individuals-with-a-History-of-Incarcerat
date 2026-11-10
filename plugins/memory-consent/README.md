# Chengmeng 自动记忆 0.4

默认自动记录本实例使用过Chengmeng的聊天，并将有来源的整理内容直接保存。无敏感词分类或检索过滤，无需逐条点确认。旧版确认记录、旧敏感标签和Markdown格式仍能读取。

## 原生工具

- `propose_memory`：自动保存一条整理内容；保留可选手动模式的pending兼容。
- `recall_memory`：检索已保存的整理内容，支持关键词/Qwen混合和时间分页。
- `recall_history`：检索自动归档的用户、助手和读取过的资料，不限90天或2000片段。
- `memory_status`：读取模式、消息数、索引状态和错误状态，不返回正文。

默认明文目录为 `<DSH_HOME>/chengmeng/memory`，本工程在 `.dsh-dev` 下。`history-archive`按会话保存JSON，`memory`按日期保存Markdown。后台CPU向量构建期间关键词仍可用；关闭历史会清理派生索引，原聊天和档案保留。

正式安装使用项目 `install.ps1`；独立安装为 `dsh plugin --profile <profile> add ./plugins/memory-consent`。Qwen环境配置和故障回退见 [CPU说明](../../docs/QWEN_CPU_MEMORY.md)。新安装默认auto；显式保存过的开关仍按用户选择读取。

HTTP接口均复用DSH的本机服务和认证。POST `/memory-query`、`/history-query`提供结构化查询；设置页自动显示保存状态，可搜索聊天和管理整理记录。`include_sensitive`与`sensitivity_hint`只作旧调用参数兼容，不再产生分类或过滤。

当前真实环境为DSH0.2.2-rc.1与Windows。完整行为、来源区分、上传文件范围与测试证据见 [自动记忆操作说明](../../docs/AUTOMATIC_MEMORY_AND_TOOLS.md) 及 [验收报告](../../docs/verification/AUTO_MEMORY_REPORT.md)。
