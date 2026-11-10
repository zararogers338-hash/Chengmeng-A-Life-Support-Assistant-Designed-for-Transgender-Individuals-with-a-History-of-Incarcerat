# Chengmeng

**带自动记忆、CPU 语义检索和文件工具的 Windows AI 桌面助手。**

Chengmeng 基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，把 Agent 预设、记忆、工具和 Pastel 界面整合成一个可直接打开的 Windows EXE。第一次运行自动解包和初始化，后续启动复用本地环境。

**[下载 Windows EXE](https://github.com/zararogers338-hash/chengmeng/releases/download/v0.5.0/Chengmeng-0.5.0-Windows-x64.exe)** · **[查看全部发行文件](https://github.com/zararogers338-hash/chengmeng/releases/latest)** · **[使用说明](docs/USAGE.md)** · **[从源码构建](desktop/BUILD.md)**

## 开始使用

1. 从 Release 下载 `Chengmeng-0.5.0-Windows-x64.exe`，约 **1.79 GB**。
2. 双击运行，等待桌面环境、六个插件和 CPU 向量环境初始化。第一次可能需要数分钟。
3. 使用自己的模型账号登录，或在上游账号界面配置自己的 API Key。
4. 在新会话中使用 **Chengmeng** 预设。安装后也可从桌面或开始菜单的快捷方式打开。

发行版面向 **Windows 10/11 x64**。无需另装 DeepSeek Harness、Node、Python 或 GPU。建议预留 **8 GB 可用磁盘空间**；向量模型启动前默认检查至少 4 GB 可用内存，资源不足或推理不可用时检索可退回关键词。

聊天模型仍需要相应的模型服务和网络，额度由使用者自己的账号提供。随包离线提供的是记忆向量模型及运行依赖。

## 能做什么

| 能力 | 内容 |
| --- | --- |
| 自动记忆 | 自动归档完整聊天，保存整理后的长期记忆，不逐条弹出确认 |
| 语义与时间检索 | Qwen3-Embedding-0.6B 在本机 CPU 上生成向量，结合关键词检索，支持查询聊天历史及时间范围 |
| 文件与网络工具 | 读取、写入、修改、查找文件；在宿主支持时查看图片、执行 PowerShell、搜索和抓取网页 |
| Agent 预设 | 提示词开头说明记忆操作流程，统一工具使用和对话风格 |
| 通用支持资料 | 日常事务、情绪支持、健康导航、社会资源与紧急支持导航；地区性信息需另行核验 |
| Pastel 外观 | 粉白蓝背景、玻璃输入框、思考强度控件、启动动画与外观设置 |

首页已精简品牌和宣传区域，保留新会话、模型选择和侧栏操作。具体工具是否出现，取决于宿主已注册的能力与当前访问模式。

## 数据与隐私

**公开 EXE 和源码包不包含开发者账号、API Key、聊天记录、记忆、上传文件或个人验收截图。** 新安装从空白状态开始。

- 程序：`%LOCALAPPDATA%\Chengmeng\packages`
- 使用者数据：`%LOCALAPPDATA%\Chengmeng\data`
- 记忆：`%LOCALAPPDATA%\Chengmeng\data\chengmeng\memory`

本版本记忆以**明文**保存在使用者电脑上，可在应用设置中管理、关闭或删除。升级程序与用户数据目录分离。

向量计算在本地完成；与在线聊天模型对话时，消息和召回的记忆片段可能作为上下文发送给使用者配置的模型服务。本地向量化不代表所有聊天均离线。

## 开发

需要 Node.js >= 22.12。插件的构建和测试不要求模型账号：

```powershell
git clone https://github.com/zararogers338-hash/chengmeng.git
cd chengmeng
npm run build
npm test
```

Windows 桌面 EXE 的构建需要匹配版本的上游运行时、Python CPU wheels 和模型权重，步骤见 [构建指南](desktop/BUILD.md)。这些大型依赖放在本地缓存和 Release 中，不写入 Git 历史。

| 目录 | 用途 |
| --- | --- |
| `plugins/agent-core` | Agent 预设、完整提示词与工具策略 |
| `plugins/memory-consent` | 自动记忆、聊天归档、检索与管理界面 |
| `plugins/pastel-theme` | 主题、玻璃效果与首页布局 |
| `plugins/startup-animation` | 启动动画 |
| `plugins/support-skills` | 通用资料与来源查询 |
| `plugins/appearance-settings` | 外观设置入口 |
| `desktop` | Windows 启动器、离线初始化及打包脚本 |
| `tests` | 单元与集成测试，使用虚构测试夹具 |

更多说明：[架构](docs/ARCHITECTURE.md) · [贡献指南](CONTRIBUTING.md) · [版本记录](CHANGELOG.md)。

## v0.5.0 验证范围

- 290 项自动化测试通过，清理后的源码包也已独立运行这套测试。
- 实测包含中文和空格的路径下全新安装、默认目录安装、快捷方式和重复打开。
- 使用捆绑的 Python 3.12 / CPU PyTorch 实际生成 1024 维向量。
- 对 EXE 载荷、ZIP 完整性、发布文件白名单和个人数据排除规则进行检查。

上述桌面实测在 Windows x64 上完成，不代表已覆盖所有硬件与所有模型服务。结果见 [v0.5.0 验证记录](docs/verification-v0.5.0.json)。

## 许可证与上游

Chengmeng 自有代码使用 [MIT License](LICENSE)。本项目是独立整合发行版，基于 DeepSeek Harness **0.2.2-rc.1**；上游代码与第三方组件保留各自许可证。

- DeepSeek Harness：MIT，[上游许可证](desktop/licenses/DeepSeek-MIT.txt)、[第三方说明](desktop/licenses/DeepSeek-THIRD-PARTY.txt)。
- [Qwen3-Embedding-0.6B](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B)：Apache-2.0；权重及许可证随 EXE 提供。
- Electron、Chromium 和 Python 依赖：许可证保留在发行版相应目录。

桌面启动器未使用商业代码签名证书。该整合版通过新的 Chengmeng Release 更新，避免上游更新覆盖定制入口与插件配置。
