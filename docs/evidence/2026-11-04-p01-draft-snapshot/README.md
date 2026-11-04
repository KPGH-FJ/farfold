# 2026-11-04 P01 草稿快照保护

同版本保存快照中的未知自有字段可能在重建时丢失，普通本地编辑随后会覆盖原保存值。本批修复composer、attachment、localAudio及其file、整理activity五个位置；不认识的结构在整份恢复发布前拒绝，原快照和后来本地输入保留。已知缺失/畸形音频来源仍保留字节并清除文件读取资格，Agent任意合法配置键保持。

首次两条行为回归修前8过2败、修后13文件166过，未保存本地原始日志，明确按已观察工具结果记录，见 [observed-results.json](observed-results.json)。关联三条缺口的执行从开始保存原日志：修前3失败4通过，修后7/7，相关4文件73项通过，见 [关联回执](associated-nested-schema-result.json)。全部实际日志逐字节归档于 [raw-check-logs.zip](raw-check-logs.zip)。

最终统一输入2366份前后摘要一致；七项均自然0，前端705文件9459项，Rust2335通过/6忽略。见 [工程结果](engineering-result.json)、[检查前输入](engineering-final-before.json)和[检查后输入](engineering-final-after.json)。源码经独立复核；原两字段修复和关联修复分别复核，未发现必改缺陷。

本批已完成源码、合成持久化回归、本机工程检查和正式d31447be7更新；候选9项/安装6项通过，三份关闭态清单一致。正式专用位置文字附件在正常退出后冷恢复；缺文件时明确拒绝，恢复原字节后显式重核成功。只移除测试附件并再次冷启动，原P02、B3四段及保留数1保持，零发送。已有生产MetaStore临时SQLite FULL/max_page_count及readOnly/query_only故障测试通过；后补[真实只读错误到前端和退出逻辑的受控连通](../2026-11-04-p01-storage-bridge/README.md)也通过。物理满盘、真实设备I/O、安装版存储故障界面及其余附件/队列路径仍未据此证明；Windows另走原生运行，不继承本机通过。

首次两字段改动的原始 `change.patch` 也逐字节保存在同一归档；本地原文件未改写。最终完整源码变更以本批提交为准。

正式更新及实际界面范围见 [formal-summary.json](formal-summary.json)。
