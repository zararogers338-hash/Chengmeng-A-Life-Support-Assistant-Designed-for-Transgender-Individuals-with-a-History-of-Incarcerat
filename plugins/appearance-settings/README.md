# 外观与启动设置

提供 DSH 设置页入口：Pastel 开关、玻璃效果（自动/不透明/标准磨砂/折射玻璃）、启动动画开关和恢复默认按钮。

偏好只保存在当前浏览器，通过 `chengmeng-appearance-change` 事件让主题即时应用。动画开关在下次打开页面时生效。系统高对比度、减少透明度与减少动态效果偏好优先。关闭主题后恢复宿主原主题。

安装：`dsh plugin --profile chengmeng-dev add ./plugins/appearance-settings`。无构建依赖，无网络调用，不改变模型、会话或 Host 记忆配置。已验证桌面 1440×900、窄屏 390×844、刷新持久化和键盘焦点。
