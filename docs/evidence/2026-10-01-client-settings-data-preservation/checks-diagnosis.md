# 全量检查的一处非稳定失败

首次完整四并发 Rust 检查为 574 通过、1 失败、3 既有忽略，见 `checks-rust-final.json` / `rust-final-2.log`。唯一失败在 `program_launch_tests::cancelled_selection_does_not_start_program_version_check` 第 210 行：第二段等待 Node 探针 marker 后触发取消，实际先返回 Node 版本无法核对；第一段一开始取消且没有启动 Node 的断言已经通过。

原样隔离复测 1/1 通过，见 `launch-cancel-isolated.json` / `launch-cancel-isolated.log`。源码没有变化。生产路径先取得 `fresh_program_version` 的 `Ok(None)`，继而返回版本无法核对；该探针返回前仍执行取消检查，marker 若已可见会传播测试指定的取消错误。当前日志不能区分 spawn、管道、等待、退出状态或截止等 `None` 来源，因此未宣称确定为超时、资源压力或已修复的取消缺陷。

此前 `../2026-10-01-work-policy-data-preservation/rust-full-recheck.log` 在 OpenDelivery 修改前已有同一用例、行号及 Node 无法核对错误。当前四个探针/启动相关文件未变，没有证据把该失败归为本片交付修复造成的回归。

保留这次失败，随后在相同冻结输入上以 `rust-recheck` 标签进行一次完整四并发复验。复验通过只证明该次全量执行，不抹去本次非稳定失败，也不代表前片默认高并发问题全部解决。两项新增实现的定向回归、独立审查和正式安装结果另行记录。
