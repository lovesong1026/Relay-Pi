# Eval 套件模型对比

三次运行均到达 Bun 的汇总行，并运行了相同的 150 项测试（共 65 个文件）。没有日志缺失、截断或在汇总前崩溃的情况（没有 auth-error / no-summary 案例）。以下计数均按各日志中的汇总原文记录。

## 汇总

| 模型                   | 通过 | 失败 | 总计 |
| ---------------------- | ---- | ---- | ---- |
| Sonnet 4.6（基线）     | 138  | 12   | 150  |
| DeepSeek V4 Pro        | 133  | 17   | 150  |
| GLM 4.7                | 131  | 19   | 150  |

说明：

- Sonnet 的汇总还报告了 `1 error`，此外有 `12 fail`；该 error 是 Bun 归类为错误而非普通断言失败的 12 项失败之一（138 pass + 12 fail = 150）。
- DeepSeek 运行约 4351 秒（测试 "state machine agent stays in state scope" 达到 600 秒超时；"judgeNarrativeShape" 达到 180 秒超时）。GLM 运行约 2082 秒，Sonnet 约 2998 秒。

## DeepSeek V4 Pro 与 Sonnet 4.6

**回归——DeepSeek 失败、Sonnet 通过（9 项）：**

- /relay routing > inline /relay flips a small task from todo_write to a state machine
- prompt cache resume > reuses cached tokens after resuming from serialized TurnState
- recall_memory implicit triggers > named referent defined in the same turn stays at zero recall
- reflection judges — judge the judge > judgeNarrativeShape returns valid=true on narrative rows (timed out at 180s)
- RPC CLI mode > accepts a multimodal prompt with an attached image
- RPC CLI mode > stitches three turns together (introduce → recall → multimodal extension)
- state machine agent stays in state scope > a planning sub-agent plans instead of implementing across repeated runs (timed out at 600s)
- structured output > returns structured output from multimodal content
- unit-sized reflections > known user steers from the source pool survive reflection (judged)

**改进——DeepSeek 通过、Sonnet 失败（4 项）：**

- observer priority inference > medium: agent reasoning / hypothesis from tool output
- recall_memory cross-session usage > asking what was done yesterday triggers recall_memory
- recall_memory implicit triggers > advice question that only personalizes via durable memory
- state machine relative cwd via --workDir + --rpc > resolves a relative script-state cwd against --workDir, not process.cwd()

## GLM 4.7 与 Sonnet 4.6

**回归——GLM 失败、Sonnet 通过（13 项）：**

- executed state is not misread as a no-op > parent reconciles executed implementing state instead of cancelling as 'nothing ran'
- observer treats tool calls as context > captures a refactor decision reached after a wide grep
- recall_memory implicit triggers > codenamed artifact dropped into a present-tense question
- RPC CLI mode > accepts a multimodal prompt with an attached image
- RPC CLI mode > stitches three turns together (introduce → recall → multimodal extension)
- state machine agent stays in state scope > a planning sub-agent plans instead of implementing across repeated runs
- state machine carries a runtime worktree path forward as override.cwd > sets override.cwd to implement's returned worktree path on the worktree-scoped steps, not on the base steps
- state machine real session c_cGfNEIotLU carry-forward > replays the corrupted-memory-db investigation and carries findings into fix_and_recover
- state machine vs todo routing > multi-phase refactor with many self-contained units routes to a state machine
- state-machine terminal acknowledgment > parent takes a follow-up action after a decided terminal
- structured output > returns structured output from multimodal content
- unit-sized reflections > known user steers from the source pool survive reflection (judged)
- unit-sized reflections > no two rows cover the same distinct insight (judged)

**改进——GLM 通过、Sonnet 失败（6 项）：**

- relay-pi memory reflect — global prune > collapses the use-cases hero supersession chain — final state survives, intermediates pruned
- provider context-overflow recovery > halves history and retries after the provider rejects an oversized prompt
- recall_memory cross-session usage > asking what was done yesterday triggers recall_memory
- recall_memory implicit triggers > advice question that only personalizes via durable memory
- recall_memory implicit triggers > named referent with no past-tense marker — pet name
- state machine relative cwd via --workDir + --rpc > resolves a relative script-state cwd against --workDir, not process.cwd()

## 结论

**Sonnet 4.6（基线）：** 三者中表现最好，得分为 138/150。其余失败集中在 memory reflection 质量（替代方案权衡、全局 prune 保留）、recall_memory 触发、OpenAI thinking-trace 路由，以及 `--workDir`/`--rpc` 相对 cwd 解析；这些问题在不同模型间普遍存在，说明更像是产品/harness 缺陷，而非特定模型弱点。

**DeepSeek V4 Pro：** 略低于基线（133 对 138，净差 −5）。它失去 Sonnet 通过的 9 项 eval，同时追回 4 项，净回退 5 项。弱点具体且一致：多模态处理（两个 RPC 多模态案例及多模态结构化输出均失败）、状态机范围约束（规划子代理运行过久，达到 600 秒超时）、`/relay` 路由和 prompt cache 恢复。它在两个 recall_memory 案例、observer 优先级推断和相对 cwd 案例上胜过 Sonnet。可以使用，但比基线稍弱，而且本次运行明显更慢。

**GLM 4.7：** 与基线差距最大（131 对 138，净差 −7），总体最弱。它在 13 项 eval 上回退、在 6 项上改善。失败高度集中于状态机编排——worktree `override.cwd`、terminal acknowledgment、no-op reconciliation、state-vs-todo 路由、范围约束和真实会话 carry-forward 均失败——此外还有与 DeepSeek 相同的多模态弱点，以及额外的 memory-reflection 问题（重复 insight 去重、steer 保留）。优点是它找回了 Sonnet 未通过的若干 recall_memory 与 context-overflow 案例。它速度最快，但状态机可靠性差距使其最不适合作为基线的直接替代品。

**总结：** 两个候选模型在通过数量上都未超过 Sonnet 4.6 基线。DeepSeek V4 Pro 更接近（−5），主要问题是多模态，以及少数状态机/路由回归；GLM 4.7（−7）主要受广泛的状态机编排失败拖累。两者都与 Sonnet 一样，在多模态结构化输出和 memory reflection 替代方案权衡上存在弱点。
