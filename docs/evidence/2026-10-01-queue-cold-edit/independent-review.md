# 队列冷编辑安装补验：独立审查

只读核对后，未发现本次旅程的实质证据冲突或需要修代码的阻断。已逐张查看 01–10 图片及对应 AX，阅读六阶段快照、比较与采集脚本、分阶段协议和退出收据，并核对最终 [README](README.md) / [installed](installed.md) 的冻结摘要。机器可复查结果见 [summary.json](summary.json)。本审查没有运行应用、Agent、测试、数据库或原采集脚本，没有修改原始记录。

## 实测支持的结果

| 观察               | 独立核对                                                                                                                                                                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原对话与选择       | [02 图片](02-original-model.jpg)及 [AX](02-original-model.txt)显示 OpenCode Zen/Nemotron 3 Ultra Free、沿用已有设置及 build；[09](09-original-amp-empty-draft.jpg) / [10](10-original-amp-medium.jpg)显示返回原 Amp 空稿且 Medium 选中。                                                                                        |
| A 与暂停队列       | [03](03-two-paused-items-with-main-draft.jpg) / [AX](03-two-paused-items-with-main-draft.txt)显示本次 A 的准确回复标记、“已完成”、B/C 两项和暂停状态。请求要求等待 120 秒；运行中工具状态只有执行记录中的 AX 观察，没有单独的 running 截图。本批没有出站 cancel，不把这些证据扩成精确计时或独立验证该短 Python 的完整生命周期。 |
| 未保存编辑稿冷保持 | [04](04-unsaved-edit-before-cold.jpg) / [05](05-cold-editor-preserved-stale.jpg)及对应 AX 保留 B_EDIT；[before-cold](before-cold.json)与 [after-cold](after-cold.json)的主输入、编辑稿和队列完整摘要分别相同。05 明确说明无法确认原待发目标，保存按钮禁用。                                                                     |
| 加入输入框         | [06](06-cold-edit-kept-in-main-draft.jpg)与 [after-keep](after-keep.json)支持 BASE 和 B_EDIT 各一份、编辑稿清除、原 B/C 队列摘要不变。此动作没有把冷编辑稿直接覆盖到猜测的目标。                                                                                                                                                |
| 重新选择后保存     | [07](07-explicit-reselection-saved-paused.jpg)及 [保存快照](after-explicit-save.json)支持第一项成为完整 B_EDIT、C 和主输入摘要保持、编辑稿清除、队列仍暂停。截图第一项预览截断，完整字面值依据快照和预先声明的公开输入核对。                                                                                                    |
| 自有清理           | [08](08-test-drafts-and-queue-cleared.jpg)与 [after-cleanup](after-cleanup.json)支持本片主输入、编辑稿和队列回到初始不存在状态；本次 A 的历史仍在。没有点击“继续发送”。                                                                                                                                                         |

冷稿禁存符合当前 [queue_edit](../../../src/runtime/queue_edit.ts) 的对象身份守卫：冷恢复只保存编辑内容与原块，不能恢复进程内 WeakMap 目标；[Composer](../../../src/components/Composer.tsx)禁用直接保存，但允许保留到主输入。重新进入当前 B 的编辑入口才取得可用目标，[sessions](../../../src/runtime/sessions.ts)替换后保持暂停。六个相关源码摘要均与本批 [候选清单](candidate-source.json)一致；本审查没有重新运行既有受控用例。

## 派生、数据和退出边界

[comparison.py](comparison.py) / [inspect_queue.py](inspect_queue.py)对准确目标、字面内容与顺序、原无关字段、冷前后摘要、加入一次、只替换第一项和自有清理的判定，与保存的输入相符。[最终派生结果](comparison-final-stages.json)56/56 项通过，12 个输入摘要均匹配；[比较脚本检查](comparison-checks.json)保存的脚本与输入摘要也匹配。这是保存收据的派生核对，不是 56 次工程测试。脚本明确不由持久字段推断运行时暂停或冷目标身份；这些结论分别来自界面和当前源码。七份 [原始 JSON 保字节摘要](raw-format-preservation.json)全部匹配，没有重新格式化原始记录。

[最终退出](after-exit.json)记录：原 36 索引摘要保持且无新增索引；基线 40 Agent 行摘要保持，但检查器没有当前 Agent 总数或新增行统计。原 49 设置仅 `unsentWork.v1` 变化，限本测试对话的 activity；原版本、主输入、选择、意见和旧队列字段保持，无新增根字段或容器键残留。因此不能写全部未发设置逐字恢复。正式 `6064d05` 二进制为 `832a6c7f3c4421c01dec91584afdc029320a4362cfb22468765c93fedc63ff49`，[复用收据](candidate-reuse.json)与退出记录均保持，455 输入至本次退出未变，未重装。

[最终协议](protocol-metadata-final.json)独立重计为 4 文件、32 startup、4 initialize、2 new、2 load、1 prompt、9 response、135 update、2 stderr 字节标记；0 authenticate/cancel/permission/list/set_config_option，0 拒绝记录。四个阶段到最终退出始终保留同一条出站 prompt，结合本次 UI 支持仅 A 发送，B/C 未发送；不把回放历史当成新发送。日志仅当前文件的完整白名单行，不能扩成正文或全部轮转记录的审计。

四个最终 startup 摘要均 accepted、childReaped、groupEnded、connectionRemoved；TERM 请求与 signal 15 记录的是应用退出清理，不是 A 工具自然结束的证明。[六个 PID + 开始时间采样](all-observed-processes.json)在退出核对中均不在；它们只有两轮应用、Amp、OpenCode，不含 A 的短 Python，也不代表全部瞬时进程清点。

本片覆盖一个原 OpenCode 对话的纯文本正常退出冷编辑、无法确认目标时禁存、加入输入与明确重选保存。B/C 发送和回复、附件队列、结果未知、保存失败、强制退出、停止、取消编辑及其他 Agent 同类旅程仍未测。最终报告保持这些边界，没有据此关闭完整 J5 或账号验收。
