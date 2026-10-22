# SWE-bench 测试夹具

这些夹具用于记录已完成的基准测试验证，不是待执行的通用示例。

`kimi-advisor.ndjson` 和 `fable-advisor.ndjson` 是手工构造的协议流，覆盖通用 `ask_advisor` 详情形态与路由器切换直方图。遥测数据从这些原始规范步骤推导调用位置，并兼容缺少较新上下文保真度元数据的旧结果详情。它们有意不包含 provider 对话记录。

`gold-30-summary.tsv` 是在固定 Mac 环境中，对已提交的 Multilingual 清单运行官方顺序黄金门禁所得的结果。30 个补丁均成功解析。耗时、实例容器峰值内存和主机临时磁盘峰值列取自 `mac/run_with_metrics.py`；被忽略的原始评分器目录保留在 `benchmarks/swebench/.cache/gold-30-20260720/` 下。

`mini-luna-2-report.json` 是针对 mini-swe-agent 未经修改的两项任务 `preds.json` 生成的官方评分器输出。它证明 mini 的官方预测行字典可直接接受，且两个非空补丁均已完成、没有评分器错误；具体命令见 `spike-notes.md`。

`container-smoke-9.json` 对照核验了每种语言各取一个已提交任务的实时打包矩阵。每个纯 GLM 回合均已完成，只使用 GLM-5.2 和产品默认的 Luna memory 模型，没有调用顾问，修改了一个 sentinel 路径，并在全新的官方容器中复现了补丁。
