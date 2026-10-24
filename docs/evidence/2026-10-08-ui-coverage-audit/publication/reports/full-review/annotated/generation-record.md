> 2026-10-24 隐私发布副本。历史结论及已测/失败/未测边界保留；本机路径和生成标识已脱敏，末尾换行统一为一个LF。实拍图、原始AX及中间数据仅本地保留，相关链接通向公开哈希清单，不表示原图已发布。

# 本轮 ImageGen 框标记录

2026-10-08 使用内置 `image_gen__imagegen`，每张截图独立一次编辑生成，共 6 次调用。每个原图均先经 `view_image` 查看；生成后复制到此目录，再逐张查看确认框位。未覆盖原图，未用程序重新绘制标注。前三张完整提示词见 [prompts.json](../../../file-inventory.html#file-058)，追加 U037 见 [prompts-U037.json](../../../file-inventory.html#file-057)，追加 U036/U045 见 [prompts-U036-U045.json](../../../file-inventory.html#file-056)。

**这是生成式定位图，不是新的产品实测截图。原图才是证据。** 即使提示词要求保持像素原貌，ImageGen 仍可能重绘字形、图标、边界或模糊；输出分辨率也从原图的 2560×1640 改为下表尺寸。不要用生成图比较像素、读取精确文字、证明修复或代替 AX。结论与时间线见 [独立观察报告](../independent-observations.md)。

| 标注图                                                                           | 原图                                                        | 尺寸      | 指向核对                                                                                                    |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------- |
| [U011-folder-guidance-annotated.png](../../../file-inventory.html#file-048)         | [U011](../../../file-inventory.html#file-208) | 1566×1004 | 1 框起步条件提示；2 框发送必须目录提示。同屏矛盾指向正确，原草稿仍可见                                      |
| [U021-file-preview-annotated.png](../../../file-inventory.html#file-049)               | [U021](../../../file-inventory.html#file-228)     | 1566×1004 | 1 框文件检查未返回说明；2 框重新打开入口。“后续未恢复”来自 actions 15–16/U022，不是 U021 单帧中的已完成重试 |
| [U030-data-responsibility-annotated.png](../../../file-inventory.html#file-050) | [U030](../../../file-inventory.html#file-246)         | 1567×1004 | 1 框清除标题与窄列说明，未框整个弹窗，保留原来不可读的纵列，未改成修复稿                                    |
| [U037-command-picker-annotated.png](../../../file-inventory.html#file-052)           | [U037](../../../file-inventory.html#file-260)              | 1567×1004 | 1 框从 rename/logout 附近延伸到底部的密集重叠区；与原图对照确认没有把长说明改成正常布局，仅作定位           |
| [U036-export-menu-annotated.png](../../../file-inventory.html#file-051)                 | [U036](../../../file-inventory.html#file-258)        | 1567×1004 | 1 框整组灰色对话菜单；说明仅称“导出后菜单仍禁用”，明确“等待过程见 U028→U036”，不以单帧证明时长              |
| [U045-draft-layout-annotated.png](../../../file-inventory.html#file-053)               | [U045](../../../file-inventory.html#file-276)        | 1567×1004 | 1 框完整窄输入区及多行控制，保留外围大面积空白；没有将输入区改宽或重排设置                                  |

新增仅为细红框、编号与简短中文说明。6 张图的框位和标注文意经过独立复看；不宣称与原图逐像素一致。六项问题都有定位图，其中导出的等待过程和其他跨帧行为仍以原始图片与连续操作记录证明。

生成源文件保留在 `[local-path]`：U011 为 `exec-[local-generation-id].png`，U021 为 `exec-[local-generation-id].png`，U030 为 `exec-[local-generation-id].png`。

追加 U037 的生成源文件为 `exec-[local-generation-id].png`，保存于同一生成目录；原图仍未改。

最后追加的 U045 为 `exec-[local-generation-id].png`，U036 为 `exec-[local-generation-id].png`，均保存于同一生成目录。两张生成后已分别打开，与原图对照复核框位与标注文意。
