# 通用专业支持资料

五个按任务选择的 Skill：日常生活、社会资源与再融入、情绪支持、用户主动需要的健康导航、紧急支持导航。资料不绑定地区，不把一般建议变成当地法规、服务资格或个体诊疗结论。

桌面发行版自动安装本模块。单独开发时，可以使用 `dsh plugin --profile <专用测试 Profile> add ./plugins/support-skills`，并显式设置专用 `DSH_HOME`；完整打包步骤见 `desktop/BUILD.md`。

`support_reference({ids:[...]})` 返回目录中的真实来源、发布信息、地区范围、证据类型和核验日期；超过 90 天标记需要重新核验。内容来自 WHO、UNODC 与美国 FTC/consumer.gov 的公开原始资料，详见 `knowledge/references.json`。该工具不联网，不能确认当地机构当前仍在提供服务。

每个 Skill 均为独立 Markdown，保持在宿主 8192 字符工具结果预算内。配置对象当前必须为空。卸载会撤销五个 Skill 与来源查询工具。
