# 默认开发服务的冷依赖扫描修复

源码ea6c01a9d仅给Vite设置optimizeDeps.entries=[index.html]。当前应用入口及按需发现保持，worker、非DOM别名、服务器和依赖均未改；历史HTML与源码原件保留。

普通暖缓存启动没有复现，最初错误期待的审计断言1保留。随后同一Vite8.2.2、同一默认配置与`--force --debug deps --host 127.0.0.1 --port 1437 --strictPort`取得明确冷路径：修改前扫描历史HTML并在10/22音频夹具出现PARSE_ERROR；修改后仅index完成扫描与优化、无此错误，根HTML与当前main.tsx均HTTP200。两次服务都能ready，不能把依赖扫描失败或手动Ctrl-C130写成CLI自然失败/成功退出。自有服务器已停止，没有启动浏览器、正式App或Agent。

完整前端四项重新执行均自然0，709文件9523项通过。2372输入前后一致且逐Git blob核合ea6；与b714只有vite.config.ts变化，104个生产产物前后内容SHA完全相同。Rust三项保留b714结果，未另跑，不称本期七条重跑。见[摘要](summary.json)与[全部原件](originals.zip)，[b714相关工程](../2026-11-05-p01-capacity/README.md)另列。

独立只读复核无必改。现有私有MCP浏览器配置使用数组合并，此后会扫描index+fixture，仍避免历史HTML全集；本轮未重新启动该私有配置，原浏览器证据保持较早输入范围。本分项不证明启动提速、worker实际运行、DOM/Tauri/安装版或Windows较早b714的新配置验收。后补进度文档另核，不反算完整工程检查。
