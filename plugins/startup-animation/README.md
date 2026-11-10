# @chengmeng/dsh-startup-animation

Chengmeng 启动动画：光穿过玻璃。设计与规则见 [docs/DESIGN.md 第 4.2 节](../../docs/DESIGN.md)。

## 它做什么

启动时覆盖纸白玻璃条，检查字体、主机连接、对话界面；安装 memory-consent 后增加“记忆模块”只读检查。全部就绪后依次揭开。关闭长期记忆不影响模块健康，也不会被动画自动打开。可跳过，对话框出现时让路，系统减少动态效果时不播放。

## 安装

```powershell
dsh plugin --profile chengmeng-dev add .\plugins\startup-animation
```

然后重启该 Profile 的 DSH。仅 Web 客户端；Node 侧没有任何注册。

## 开发

```powershell
npm run build      # 构建 lib/client.js（在本目录）；或在仓库根目录 node plugins/startup-animation/scripts/build.mjs
node --test tests/unit/startup.test.mjs      # 在仓库根目录
```

预览页（模拟检查，可调每项的就绪时间，99999 表示一直不就绪以测超时）：先在仓库根目录 `npm run preview`，再打开 `/preview/startup.html`。

## 设置

| 键 | 值 | 作用 |
|---|---|---|
| `localStorage['chengmeng.appearance.startup']` | `off` | 关闭启动动画 |
| `localStorage['chengmeng.startup.diag']` | `1` | 记录诊断信息到 `window.__cmStartupDiag`（覆盖层挂载时间、结果），用于实测 |
| `globalThis.__CHENGMENG_CONFIG__.agentDisplayName` | 字符串（≤24 字符） | 显示名称，默认 `Chengmeng`（统一配置落地前的约定钩子） |

## 目录

```text
src/schedule.js        纯函数：时间调度、阶段、是否播放、玻璃条数量
src/config.js          纯函数：显示名称、设置读取
src/startup.js         样式 + DOM 控制器（不依赖 DSH 和 React，预览页共用）
src/client-entry.js    DSH 客户端入口：三个真实检查、官方槽位注册、对话框让路
src/springs.js         弹簧 token（拷贝自 pastel-theme，与 liquid-glass-motion Skill 逐项核对）
```

## 已知限制

- DSH 自带的"HARNESS"加载页早于本插件，无法替换（要改 DSH 源码）；顺序是 DSH 加载页 → 本动画。
- 记忆检查仅请求同源 `/chengmeng-memory/status`；没有安装时不显示，异常时按超时规则让路。
- Electron 桌面版的窗口拖动没有实测（只测了 Web 版）。
