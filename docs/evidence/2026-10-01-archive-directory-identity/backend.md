# 归档目录身份：后端实现与定向验证

本片只操作临时数据库、自有目录链接和既有合成协议对端；未启动正式应用或真实 Agent，未读写正式数据。安装版结果由根任务另行记录。最终文件身份见 [backend-source-final.json](backend-source-final.json)。

## 实现范围

- [session.rs](../../../src-tauri/src/acp_client/session.rs) 在后台核实原索引目录的规范路径，保留原路径和规范路径两个精确目标。使用现有打开保留机制分别保护两个目标；同一个连接去重，两个不同连接拒绝归档，不按会话标识跨目录寻找连接。
- [session_commands.rs](../../../src-tauri/src/acp_client/session_commands.rs) 的原归档接口增加可选 `expectedCwd`。它只可否决与前端刚核实路径不同的结果，不能指定连接、触发另一轮解析或使失败回退放行。取消归档忽略该值。
- [pump.rs](../../../src-tauri/src/acp_client/pump.rs) 保留任务、工具、权限、模型和待处理表单检查。两份打开保留对象与应用操作许可一起移入原归档命令和存储任务，调用方离开不会提前释放其中一份。
- [meta_store/archive.rs](../../../src-tauri/src/meta_store/archive.rs) 在原 SQLite 事务中重新核对索引的 Agent、目录和会话标识；再次解析原目录，必须仍等于本次捕获的规范路径。原路径和规范路径下的输入、队列编辑、文件意见、队列及待发送目标均受保护。只更新原索引的归档状态与时间，不移动或新增索引，不改模型、标题、置顶或服务来源。

目录不存在、悬空链接、不是目录或无法核实，均拒绝归档并提示恢复访问后重试；取消归档仍只更新本地状态。这是明确的准入收窄，没有推导最近祖先，也没有新增别名表。一次操作中的复核不等于持久记录历史链接目标，亦不声称锁住外部文件系统变化。

## 真实红与绿

| 收据                                                                               | 结果与范围                                                                                                                                                                        |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [首轮红](backend-red.json) / [日志](backend-red.log)                               | 5 项中 3 失败、2 通过。规范路径草稿、队列和忙连接未阻止原路径索引被归档；同标识不同目录两项隔离通过。                                                                             |
| [补充红](backend-boundaries-red.json) / [日志](backend-boundaries-red.log)         | 9 项中 7 失败、2 通过。增加保存意见、队列编辑、首次发送指针、规范路径正在打开、双连接歧义及目录无法核实的边界。组合用例的红在首个失败断言停止，不能宣称其中每个输入都已独立跑红。 |
| [提交前改指红](backend-retarget-red.json) / [日志](backend-retarget-red.log)       | 3 项中 2 失败、1 通过。核验后改指、删除目录仍错误归档；原索引身份核对和新标题/置顶保留正例通过。                                                                                  |
| [前后端窗口红](backend-expected-red.json) / [日志](backend-expected-red.log)       | 16 项中 1 失败、15 通过。前端核验 A 后链接改指 B，缺少 expectedCwd 否决时仍归档。其他已修边界首次通过。                                                                           |
| [主体绿](backend-green.json) / [日志](backend-green.log)                           | `archive` 筛选共 31 项通过，含 14 项新目录身份回归、2 项原归档、1 项原存储保护以及 14 项同名目录/压缩包测试；不把后 14 项计为本片新增覆盖。                                       |
| [权限保护](backend-permission-green.json) / [日志](backend-permission-green.log)   | 原权限保护 1 项通过。                                                                                                                                                             |
| [工具活动保护](backend-tools-green.json) / [日志](backend-tools-green.log)         | 原工具活动保护 3 项通过。                                                                                                                                                         |
| [最终目录检查](backend-directory-final.json) / [日志](backend-directory-final.log) | 统一目录错误文案后的 14 项目录身份回归全部通过，退出 0。                                                                                                                          |
| [最终格式检查](backend-fmt-final.json) / [日志](backend-fmt-final.log)             | 最终 Rust 格式检查退出 0。                                                                                                                                                        |

新回归在 [archive_alias_tests.rs](../../../src-tauri/src/acp_client/archive_alias_tests.rs)，由 [archive_tests.rs](../../../src-tauri/src/acp_client/archive_tests.rs) 注册并复用原合成对端。忙连接和双连接用例先完成取消、等待断开，再作红测断言。取消调用方的用例截获真实归档派发命令，验证其中两个保留对象不随调用方消失；由受控接收者完成存储操作后释放，不将此用例写成真实超时或安装版测试。

[进程核查](backend-process-check.json) 仅覆盖新夹具明确打印的采样 PID；测试内已等待断开，检查时这些 PID 均不在，不宣称全面后代审计。未运行全量 Rust 检查、打包或安装；由根任务接续。
