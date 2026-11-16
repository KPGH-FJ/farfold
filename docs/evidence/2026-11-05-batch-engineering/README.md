# 603检查点：工程与P01 SQLite证据

此记录限定较早已稳定的603056dd11baea68a438f686ee83f96d89377ba4检查点。随后发生的MCP焦点修复、后续文档与源码变化不在此结论内，须按影响另核；执行顺序仍在唯一计划，当前事实见status。

最终2372项声明输入的前后映射逐字节一致，已保存的git-input-binding记录全部对应603提交blob；这是固定内容归属，不声称七条命令执行时HEAD已是603、不声称连续文件锁、文件mode或完整传递环境冻结。后续变更不会被这里的通过记录自动覆盖。

首次工程实际执行6项：前端1失败/9517通过（709文件），其他5项自然0；前端失败后JS序列没有执行build，不能称该轮完整七项。失败来自音频正控夹具带有真实writer从未产生且既有严格恢复入口已拒绝的paused:true。032d8a03e34d9bae1c2233dfadedd2d0cfae0c19只移除此夹具冗余字段，生产guard及全部原断言保留，关联4文件57项通过。初末声明输入仅该测试文件不同，原失败/纠正patch/解释/回执均完整保留。

纠正后重新实际执行完整七项，未借用首轮其余成功回执：709文件9518项前端、Rust库2349通过/0失败/7忽略。build原始日志仍保留包体/动态导入建议，不称零警告。完整工程的7个忽略不因下面显式driver实验而改算为通过。

P01单独GREEN联通：1文件1用例自然0，8个真实默认ignored Rust driver子进程各1通过、自然0。生产MetaStore在独占临时SQLite中读写自有fixture，真实前端在未知queue字段时拒绝load与flush，原JSON值保持、零前端settings_set、本地新输入保留。随后由测试显式写入另一个支持的backupfixture，再通过实际draft/session函数保存并冷模块/新SQLite连接读回；已知队列、官方PromptBlock._meta及本地新输入保持。替换backup是fixture控制，不是应用恢复UI。SQLite没有被制造readonly/FULL故障，本桥也没有新SQLite RED；不可把此前合成storage RED改称真实SQLite RED。

原执行result与只读独审结合证明自有临时目录清理路径成功；没有另扫任意临时目录来补独立不存在观测。0700目录、0600请求响应、token/UID/inode/普通单链接检查限定受控fixture，不宣称原子抵抗同UID恶意替换。

originals.zip保留完整原件字节、原路径和必要脚本；archive-manifest.json列每个payload的来源、大小和SHA256，并同字节置于ZIP中。JSON里的原路径不改写，解读时用manifest映射ZIP成员。checkpoint-source只收与固定2372map哈希相符的必要源文件；不含当前焦点组件改动。复现需要仓库完整603源码、既有依赖和显式新二进制绑定；不要直接运行历史绝对路径脚本或复用已可能改写的共享target二进制。二进制SHA仅为当时真实命令/独审回执，不是本次下载或现时二进制重哈希。

未收录二进制、临时数据库、正式App、账户/用户数据库或浏览器UI原件。本胶囊没有安装、App重启/退出、真实Agent/账号/模型、完整IPC、真实恢复UI、Windows全量成功、完整P01或29家八项验收结论。普通检查、桥接、安装版和真实使用证据分别记。

基础原件的独审为independent-final-review.json；它审的是当时原件，不冒称另一位审阅者已独审这个新ZIP。本次只读汇总/字节归档，无新工程检查、SQL/Agent/App操作。

主代理已核ZIP CRC、93成员和92个payload大小/SHA，归档清单内外同字节。ZIP内保留准备时README原件，公开README后补本句不替换历史成员。后续[浏览器与焦点](../2026-11-05-mcp-scope-review/README.md)另有输入与检查范围，不由本批自动覆盖。

后续公开胶囊的[独立复核](publication-review.json)分别保留603/65c/6f范围；[进度补记核对](progress-alignment-review.json)证明151原编号/顺序/标题/完成条件及16包共用要求不变。后补要求参考仅进度字段变化，其他2371个声明输入保持，不冒称补记文档执行过七项。

本大阶段最后的[进度核对](final-progress-review.json)以ea6为源码检查点，P01/P39/P41/P49/H18仅进度变化，151原编号/顺序/标题/条件、16包与共用要求均不变，其他2371个声明输入保持。后续容量、开发服务与两份Windows分项各按自身固定源归档，不由本603旧批覆盖。
