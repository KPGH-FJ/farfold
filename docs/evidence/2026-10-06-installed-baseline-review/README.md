# 安装基线复核（2026-10-06）

源码与已测输入一致：基线 `9ed2e6be`、修复源码 `c0f8d7e3`；前端2101、Rust965通过（4项原忽略）。仅核现有工程证据并补完整打包，不重复无变化测试，不启动真实Agent或追加消息预算。

- [baseline.json](baseline.json)记录旧正式应用：0.1.7、arm64、主程序 `c97e9b23…`，与10月5日安装回执一致，检查时仍运行。版本号与未签名release文件不能证明源码身份。
- [source-inputs.json](source-inputs.json)保留710项实际构建输入摘要；[build-result.json](build-result.json)及原始日志记录本次Tauri locked release成功。打包前后输入与HEAD稳定。
- [candidate.json](candidate.json)记录新签名包 `384f3fed…`、ZIP位置与摘要；严格签名、5项文件、ZIP内容及执行权限通过独立复核。未公证、未发布；本任务临时bundle在核验归档后移除，保留ZIP供唯一正式应用升级。
- 旧正式应用5文件摘要未变；未退出、替换或启动应用，未读取秘密，未动既有未提交目录。安装须用户保存并退出确认，再核静止数据与新应用；实测顺序仅见[活动计划](../../../plans/agent-access.md#实测准备与顺序2026-10-06)。本次不是安装验收、真实Agent验收或Windows实机验证。
