# 登录声明的程序目标核验

本片修复由 `a1bb4c5` 的 Kilo 安装观察确认的错误登录目标：缺省 Agent 方法的旧终端扩展写了 `opencode auth login`，Farfold 原实现会直接查找并执行该命令。先前未点击登录、未执行错误程序；事实与固定来源见[目录补验](../2026-09-30-agent-access-directory/README.md)。

## 当前边界

认证修复正在实现和验证，尚未安装。正式应用仍是启动参数候选 `0b6d74c`，主程序摘要 `3525b983…dac7ade0`，已退出。本片不把测试或官方声明当成真实登录成功。原有账号、密钥、模型及历史不因修复而替换；未知目标保留手动配置入口，不能通过自动切换成协议认证掩盖声明问题。

前端通过通用 `unavailableReason` 呈现当前方法无法自动执行的原因，同时保留其他方法、手动配置与重新检查。新模型字段复用已有表单样式并关联错误说明，账号下拉框使用已有统一样式；详见[前端范围与定向证据](frontend.md)。[最终前端检查](checks-frontend-select-final.json)中类型检查、123 文件 / 1,028 项测试与生产构建通过；此前[输入框检查](checks-frontend-final.json)保留原记录。

后端目标是让展示、执行与协议认证准入使用一致规则：标准 Terminal 按已配置程序执行；旧扩展严格解析并核对实际可执行文件及脚本入口；已核实伴随程序沿既有依赖路径；未知或畸形声明在读取凭据和启动程序之前停止。Kilo 补充限固定版本、精确声明和受管安装证据，不按描述文字猜命令，不替换其他 Agent 名称。

[数据基线](data-before.json)和[未发字段摘要](unsent-before.json)在 Gemini 补验后于 23:25 刷新为 26 条会话、9 个 Agent、18 项设置，只保存摘要。23:08 的原基线分别保留为 [data-before-gemini.json](data-before-gemini.json) 与 [unsent-before-gemini.json](unsent-before-gemini.json)。具体安装、真实终端过程、取消与返回以及退出回收结果待执行后另记；成功认证与模型请求需各自证据。
