# 固定协议错误分类与已结束终端记录

本候选合入两项增量：出站协议错误增加有限、无正文的分类；已结束的登录/配置终端显示“查看终端记录”，展开仍复用原输出，不重新运行。前者用于进一步核实 Junie 当前失败，后者修复 Copilot 安装实测发现的误导文案。

- 后端范围、实际受控红绿及丢记录边界见 [backend.md](backend.md)；不是 Agent 根因或成功验收。
- 前端为 `8c42ac9`，范围与定向结果见[终端记录片](../2026-10-01-agent-terminal-records/frontend.md)。
- [前端完整检查](checks-frontend-full.json)：1,144 项、类型及构建通过；[307 输入](frontend-inputs.json)至整体验证冻结保持。
- [后端完整检查](checks-rust-full.json)：494 项通过、3 项既有忽略，fmt/clippy 通过；[作者 7 文件](source-final.json)摘要保持。
- [整仓格式](checks-format-final.json)、[独立联合审查](review.md)与[431 构建输入](candidate-source.json)保留候选范围。

安装待办：原 Copilot 登录启动/取消后查看记录且不重跑，Junie 原固定目录安装重试及错误分类，Minion 候选公开依赖版本采样；再检查预览/导出、原稿、原数据、进程回收和重复应用清理。采样不执行额外 Agent 或导入包，公开元数据不直接认定为实际异常原因。账号授权、全目录首发与续接仍未完成。
