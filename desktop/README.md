# Chengmeng 桌面版

双击 `Chengmeng.exe`。第一次打开会在本机自动解包桌面运行环境、六个插件、Qwen3-Embedding-0.6B 权重和 CPU Python 环境，然后打开原生桌面窗口。后续启动复用已安装文件。

不需要另装 DeepSeek Harness、Node、Python 或 GPU。首次解包需要数分钟和约 5 GB 可用磁盘空间。模型推理默认 CPU，空闲时释放；内存不足时检索自动退回关键词。聊天模型仍需网络和用户自己的账号；新电脑第一次需在应用内登录。

默认程序目录：`%LOCALAPPDATA%\Chengmeng\packages`。

默认用户数据：`%LOCALAPPDATA%\Chengmeng\data`；整理记忆位于其中 `chengmeng\memory`，聊天、附件也在该数据根目录下。首次安装是没有登录、聊天、记忆或上传文件的空白环境；升级程序不会清空使用者自己的数据。

在本机继续已有数据可用：`Chengmeng.exe --data-home "已有 DSH_HOME 的完整路径"`。成功启动后记住此选择。先关闭使用同一数据目录的旧服务，避免两套服务同时写入。程序不会把账号、记忆和聊天打入 EXE。

`--install-root "完整路径"` 指定解包根目录；`--isolated` 不读写默认启动偏好；`--no-shortcuts` 不创建快捷方式；`--prepare-only` 只解包、配置而不打开窗口；`--quiet` 用于自动验收，错误写入所选安装根目录的 `launcher.log`。这些选项不影响普通双击使用。

## 第三方组件

Chengmeng 自有源码使用 MIT 许可证，见根目录 `LICENSE`。配套 `Chengmeng-0.5.0-source.zip` 包含插件与桌面启动器源码及构建说明，不附带开发者个人资料。

这是基于 DeepSeek Harness 0.2.2-rc.1 的独立 Chengmeng 整合版，不是 DeepSeek 官方发行版本。保留上游运行时及版权文件，修改入口来隔离桌面状态，并预装 Chengmeng 插件；此整合版通过新的 Chengmeng 安装包更新，关闭了上游自动更新入口，以免覆盖集成配置。

DeepSeek Harness：MIT，见 `licenses/DeepSeek-MIT.txt` 和 `licenses/DeepSeek-THIRD-PARTY.txt`。Electron、Chromium 和运行时的许可证保留在 `app` 目录。Qwen3-Embedding-0.6B：Apache-2.0，见 `embedding/model/LICENSE`。各 Python 依赖保留 wheel 中的许可证/元数据。

本地打包的启动器未使用商业代码签名证书。
