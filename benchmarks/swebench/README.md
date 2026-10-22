# SWE-bench 基准测试

本目录负责 SWE-bench Multilingual 基准测试的完整工作面：测试活动输入、编排、E2B 与 Mac 执行、fixture、运行产物和测试。它与产品测试目录有意分开。

[已完成的顾问 harness 设计依据](../../specs/done/swebench-harness/README.md)记录了基准测试的不变量和权衡。最终 Mac 对比结果保存在[精简结果记录](results/mac-advisor-comparison-20260721.json)中。修正后的 50 项 Opus/GLM E2B 对比单独保存在[模型结果记录](results/e2b-opus-glm-comparison-20260723.json)中。扩展后的 50 项模型与顾问成本对比见[八组 E2B 结果记录](results/e2b-eight-arm-cost-50-20260723.json)，该记录取代了其扩展的[27 项检查点](results/e2b-eight-arm-cost-panels-20260723.json)。

单独运行此目录中的 Docker 化 TypeScript 测试套件：

```sh
bun run test:swebench
```

Mac 评分器辅助工具的 Python 测试位于 `mac/tests/`；固定版本的 Mac 配置器会在安装环境后运行这些测试。产品测试仍位于仓库根目录的 `test/`，使用 `bun run test` 运行。

最终测试活动的 E2B 模板与驱动程序位于 `e2b/`。两者都要求使用干净且已推送的提交，以确保 worker 模板、来源锁文件和源代码树保持一致。模板会编译 Relay Pi，并使用纳入版本控制的 `dataset/` 数据集快照；datasets-server 只提供会变化的当前版本，因此 worker 构建期间不得重新获取测试活动输入。

```sh
bun benchmarks/swebench/e2b/template.ts
bun benchmarks/swebench/e2b/run.ts --capacity-only
bun benchmarks/swebench/e2b/run.ts
```

最终环境门禁或定向恢复可重复使用 `--instance <id>` 参数。只有驱动程序的全局预算计算允许增加预留资源后，才添加 `--retry-failed`。
