# Chengmeng v0.5.0

首次公开的 Windows x64 桌面整合版：自动记忆、本地 CPU 语义检索、文件与网络工具，以及 Pastel 界面。

## 下载和使用

下载本页附件 **Chengmeng-0.5.0-Windows-x64.exe**，双击即可自动解包和初始化。无需另装 Node、Python 或 GPU。首次准备可能需要数分钟，之后可使用桌面快捷方式。

EXE 约 **1.79 GB**，包含 Qwen3-Embedding-0.6B 权重和离线 CPU 依赖。使用者需登录自己的模型账号或配置自己的 API Key；发行包不带账号、聊天、记忆或上传文件。

运行环境：Windows 10/11 x64，建议预留 8 GB 磁盘空间。聊天模型需要相应的网络服务；本地向量化可在离线状态运行。

## 本次内容

- 六个插件已集成：Agent 预设、自动记忆、Pastel 主题、启动动画、通用资料和外观设置。
- 自动归档聊天，支持整理记忆、语义与关键词检索，以及按时间查询。
- CPU 向量模型无需 GPU，检索支持关键词降级。
- 主工作界面精简品牌/宣传内容，并调整新会话按钮的位置。
- 应用版本目录与使用者数据目录分开，重复打开回到同一窗口。

## 校验

EXE SHA-256：

```text
21de3156ab172c06c4df112682acfbbfd2d6401391be7a0a721d7e9aff756acc
```

也可下载对应 `.sha256` 文件。PowerShell 检查：

```powershell
Get-FileHash .\Chengmeng-0.5.0-Windows-x64.exe -Algorithm SHA256
```

## 验证和说明

290 项自动化测试通过；已在 Windows x64 实测全新安装、中文和空格路径、快捷方式、重复启动及 1024 维 CPU 向量计算。发布内容审计排除了开发者个人数据。

启动器未使用商业代码签名证书。记忆以明文保存在使用者电脑上；在线聊天服务可能接收消息及召回上下文。具体数据位置见 [使用说明](https://github.com/zararogers338-hash/chengmeng/blob/main/docs/USAGE.md)。

Chengmeng 自有源码采用 MIT。基于 DeepSeek Harness 0.2.2-rc.1 独立整合发行，上游和第三方组件保留各自许可证。
