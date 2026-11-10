# 构建空白的 Chengmeng 桌面版

## 构建环境

Windows 10/11 x64；官方 DeepSeek Harness 0.2.2-rc.1；Node.js >=22.12；Windows 自带 .NET Framework 4.x C# 编译器。构建工具通过 `npm ci --prefix desktop --ignore-scripts` 安装。

1. 用官方桌面包自带的 Python 3.12 执行 `desktop/fetch-build-inputs.py`，获取锁定的 CPU wheels 和模型。可先将同版本的已校验模型复制到 `.runtime/qwen-embedding/model`，离线 wheels 放入 `.desktop-build/wheels-cp312`。
2. 在 PowerShell 执行 `desktop/build.ps1`；如官方安装不在默认位置，传入 `-VendorRoot`。
3. 输出 `dist/Chengmeng-0.5.0-Windows-x64.exe` 和 SHA-256 校验文件。`desktop/package-source.py` 生成配套开源源码包。

## 发布边界

EXE 仅从白名单 staging 目录读取：公开的上游桌面运行时、六个插件、CPU 模型与 wheels、初始化脚本、许可证。打包器明确排除 staging 内测试生成的 venv、ready 标记、账号文件及桌面浏览器数据。安装时在接收者电脑现场创建 venv 和桌面配置，不预装任何开发者账号或记忆。

源码包仅含自有运行源码、测试夹具、桌面构建代码和这份公开指南。历史对话、需求讨论、个人验收日志、截图、旧发布目录、`.dsh-dev`、`.runtime`、浏览器状态、账号文件都不在源码白名单内。

`desktop/audit-release.py` 验证 EXE 尾部及 SHA-256、ZIP 完整性和文件白名单，扫描自有文本文件里的本机用户名/路径，以及凭证文件、聊天、记忆、上传目录。审核输出只给出文件名和计数，不输出账号内容。

## 运行实现

WinForms x64 启动器后面附 ZIP64 载荷和 56 字节校验尾部。第一次启动校验并解包到版本/摘要目录，然后调用捆绑 Node/Python 初始化。完成后安装一个小启动器与桌面、开始菜单快捷方式，后续启动不再重复解压。

数据目录和应用版本目录分离；仅更新六个自有插件与带标记配置块，修改前保留 profile 备份。程序按数据根目录持有进程互斥锁；重开时交由原生单实例机制激活已运行窗口。旧网页 host 仍在同一数据目录运行时，不开启第二个写入进程。

原生壳保留上游 dsh 运行时，只修改副本 ASAR 的入口及发行元数据；保留全部 unpacked 标记和原始运行时内容。自定义入口设置独立 userData 与窗口标题。上游自动更新被关闭，本整合版通过新的 Chengmeng 包更新。

第三方运行时不纳入 Chengmeng 的 MIT 授权声明，其各自许可证随二进制保留。上游项目源码：[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。模型：[Qwen3-Embedding-0.6B](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B)。
