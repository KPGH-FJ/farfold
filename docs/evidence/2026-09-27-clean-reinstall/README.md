# 清空重装供用户试用

用户明确要求卸载旧 Farfold、清理残留并安装最新本地版本，随后补充“会话、草稿等等都删掉”。本次据此清空 Farfold 自身数据；源码、Git、其他恢复证据及独立 Agent 账号与历史不在删除范围内。

- 源码：HEAD `eefa4dfaaaf47b2f802d040b96cba82e6d3b807f` 加现有未提交工作；[245文件摘要](source.json)与候选九一致，本次没有生产代码修改。
- 安装：重新打包成功，唯一正式应用 `/Applications/Farfold.app`，0.1.7 / `ai.farfold.desktop`；[安装摘要](installed.json)确认4个文件与生成包一致、签名有效，主程序 SHA256 `242b9e8b21323d2c05d1c3025648931b0ff6ebcd434a03128763a6f211904d94`。
- 删除：[精确清单](inventory-recommendation.json)和[执行回执](reset-completed.json)记录旧应用与9个数据、缓存、WebKit、偏好及日志根；原正式版83条、旧开发版16条会话随所属数据目录清空。2条 Farfold 托管凭据已删除，[钥匙串复核](keychain-after.json)为0条；只查询属性，没有读取秘密。
- 重复程序：[删除证明](duplicate-apps-removed.json)记录3个历史0.1.6应用及本轮打包副本。各恢复目录的其他内容元数据保持一致，没有清空整个 target。
- 启动：[首次使用截图](fresh-start.jpg)显示0会话、0收藏、无已接入 Agent、空白输入框；[新数据核对](fresh-state.json)确认0会话、0 Agent记录、0忽略记录，仅初始化默认设置。应用留在首次使用页供用户操作，本次没有发送消息或导入历史。

本次通过重装、签名、包一致性及空白启动验证；没有重新执行完整产品验收，也不改变此前外部服务失败和未测项目的结论。
