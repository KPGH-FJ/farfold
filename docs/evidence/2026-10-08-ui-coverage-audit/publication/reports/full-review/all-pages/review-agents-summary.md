> 2026-10-24 隐私发布副本。历史结论及已测/失败/未测边界保留；本机路径和生成标识已脱敏，末尾换行统一为一个LF。实拍图、原始AX及中间数据仅本地保留，相关链接通向公开哈希清单，不表示原图已发布。

# Agent、认证与 API 逐图复核

本轮复核既有40张原图：4张本轮安装截图、19张历史安装截图、17张受控组件截图。逐张使用 view_image 查看原图；21份已提供AX文本全部核对。未操作应用或浏览器，未读取产品实现，未修改生产代码。

每张图都有独立核对维度、正常反馈、局限和问题；JSON含57个百分比标注框、9条任务路径。15项可见问题与3项风险分别记录；“可见”仅指相应材料中的呈现，组件观察不升级为安装版或真实认证故障。13张未出现新增明确问题。

重点是：H18/H19模型冲突没有原值/现值对照；H20/H21已有设置没有当前身份/来源；H25/H26获取API指引没有可执行的获取路径；H22/H23自定义接入整窗滚动，顶部和提交区不能同时维持可见。未测试不当作失败，程序连接也不当作认证或模型成功。

| key | 级别 | 状态 | 问题 | 证据 |
|---|---|---|---|---|
| agent-management-context | S3 | observed | 管理目录仍以探索和开始对话为主要语境 | U032、H14 |
| auth-method-language | S3 | observed | 认证方式的关键说明未对齐中文界面 | U034、H05、H17 |
| program-update-scope | S3 | risk | 重新下载与更新合在同一按钮，当前页面未说明目标版本 | U035 |
| agent-tab-ax-conflict | S3 | risk | 程序页的可访问性快照同时把多个分类标为已选择 | U035 |
| agent-capability-scan | S3 | observed | 能力名称与能力值缺少可扫描的配对层级 | H04 |
| agent-capability-provenance | S3 | observed | 能力说明混合“声明”和“已验证”但未逐项区分 | H04 |
| agent-current-identity | S3 | observed | 已有接入缺少可辨认的当前账号或来源摘要 | H05、H20、H21、R-A04、R-A05 |
| agent-management-wizard | S3 | observed | 已可使用的日常管理仍用连续准备步骤作为主动作 | H05、H06、H20、H21 |
| agent-import-location | S3 | observed | 带入已有对话藏在程序维护区下方 | H06 |
| model-difference-opaque | S2 | observed | 模型冲突要求重新确认，却未展示原选择与当前设置的差别 | H18、H19 |
| model-source-hidden | S3 | observed | 模型确认页未直接呈现当前服务来源 | H18、H19、R-A08、R-A09 |
| custom-form-frame-scroll | S3 | observed | 自定义接入的整个弹窗滚动，首屏无提交区、底部无标题退出区 | H22、H23 |
| api-guide-no-route | S3 | observed | 获取 API 指引要求额外输入，却没有给出可执行的获取路径 | H24、H25、H26 |
| api-discard-new-copy | S4 | observed | 新增 API 的放弃提示提到不存在于本次流程的上次保存 | H27 |
| registration-help-no-link | S3 | observed | 注册提示只有“官方渠道”，没有可执行入口 | R-A01、R-A02、R-A03、R-A13 |
| terminal-api-choice-ambiguous | S3 | observed | 模型服务与模型 API 服务的选项名称难以区分设置方式 | R-A02、R-A03 |
| model-empty-recovery-mismatch | S3 | observed | 模型尚未选择时提示保留已有选择，且未解释读取按钮为何不可用 | R-A08 |
| key-form-exit-scope | S3 | risk | 密钥表单并列多个退出层级，取消的作用范围不清楚 | R-A14 |

完整结果见同目录 `review-agents.json`。已检查40个ID与输入完全一致、无重复；问题字段、证据引用、流程引用及所有0–100百分比矩形范围通过确定性校验。

真实登录、PTY执行/完成、模型读取/保存/请求、API密钥校验、服务切换与返回、更新目标、读屏与键盘行为仍须交互验证。R-A12服务已选却无继续按钮属于未水合组件状态，不列为卡死；R-A17依赖名称为合成样例，不列为真实环境缺失。
