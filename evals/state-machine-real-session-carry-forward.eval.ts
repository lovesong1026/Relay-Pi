import { describe, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import dedent from "dedent";
import { startTurn } from "../test/helpers/turn-runner-protocol.js";
import { TurnRunner } from "../src/turn-runner/turn-runner.js";
import type { TurnEvent } from "../src/types/protocol.js";
import type { StateMachineDefinition } from "../src/types/state-machine.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const model = process.env.EVAL_MODEL ?? "sonnet-5";

/**
 * 重放 session `c_cGfNEIotLU`（“调查损坏的记忆数据库”），保留原始用户提示词、
 * definition name、state names 和第三个状态的字面 prompt。前两个 agent 状态替换为
 * script 状态，打印真实子 Agent 产生的原样输出（保存在
 * `evals/fixtures/session-c_cGfNEIotLU/` 下），因此父 Agent 会收到真实编排器所见的
 * 完全相同的紧凑结果。
 *
 * 原始编排器在没有修改静态 prompt 的情况下转移到 `fix_and_recover`；静态 prompt
 * 只模糊提到“调查结果”/“之前发现的损坏 DB”。新子 Agent 看不到这些发现，于是
 * 提出了三个澄清问题——这就是 carry-forward bug 的可观察表现。用户随后用很长的
 * `override.prompt` 重新运行状态，将调查和诊断结果内联进去。
 *
 * 此 eval 断言修复后的流程：在转换时，父 Agent 必须通过 `override.prompt` 或 `input`
 * 内联具体发现（PGlite、embedding-worker 外键竞争、具体仓库路径、打开竞争根因），
 * 使第三个子 Agent 无需再次询问用户就能行动。
 */
describe("state machine real session c_cGfNEIotLU carry-forward", () => {
  testIfDocker(
    "replays the corrupted-memory-db investigation and carries findings into fix_and_recover",
    async () => {
      const recoverDir = await mkdtemp(join(tmpdir(), "sm-recover-"));
      const fixtureDir = join(import.meta.dir, "fixtures/session-c_cGfNEIotLU");
      try {
        const definition: StateMachineDefinition = {
          name: "Investigate corrupted memory DBs",
          prompt:
            "找出 ~/.relay-pi 下记忆数据库损坏的根本原因，复现故障模式，判断是否与 embeddings 有关，修复源头问题，并尝试从现有损坏数据库中恢复数据。",
          states: [
            // 原始的前两个状态是 agent 状态；将它们替换为打印记录原样输出的 script 状态，
            // 可以让 eval 保持低成本且确定性，同时保留原始编排器看到的完全相同的紧凑结果。
            {
              kind: "script",
              name: "survey_corruption",
              cwd: fixtureDir,
              command: "cat survey_corruption.txt",
            },
            {
              kind: "script",
              name: "reproduce_and_diagnose",
              cwd: fixtureDir,
              command: "cat reproduce_and_diagnose.txt",
            },
            {
              kind: "agent",
              name: "fix_and_recover",
              cwd: recoverDir,
              // 来自原始 session 的原样 prompt。静态短语“修复根本原因”和“之前发现的损坏 DB”
              // 在全新的子 Agent 上下文中没有具体指代——父 Agent 必须在选择该状态时，
              // 通过 override.prompt 或 input 向前传递调查和诊断结果。
                prompt:
                "在仓库中修复根本原因（采用最小且正确的改动，遵循 AGENTS.md：不要添加薄封装，保持名称与当前设计一致，运行类型检查、lint 和相关测试；会写文件的测试必须通过 docker 运行）。然后编写恢复脚本，以只读方式打开每个损坏的数据库，导出可恢复的行（尝试 `.recover`、`.dump`，以及逐行 SELECT 并跳过错误），再将数据重新插入同一路径上的全新数据库（先将损坏文件备份为 `<path>.corrupt-<timestamp>`）。针对前面发现的实际损坏数据库运行恢复脚本，并分别报告每个数据库恢复和丢失的行数。返回：可用于提交的修复摘要、验证输出（类型检查/lint/测试）以及恢复统计。",
              // Bound the sub-agent for eval cost. The carry-forward decision
              // we are measuring happens at transition time, before this
              // sub-agent runs; this systemPrompt only keeps the actual run
              // cheap and assertable. The instruction is repeated and given
              // in imperative form because the parent's system prompt
              // strongly encourages tool use, and a single "do not call
              // tools" line otherwise loses to the tool-use prior.
              systemPrompt: dedent`
                绝对约束——这是一个 eval 沙箱：
                - 不得调用任何工具，包括 bash、read、edit、write、grep、git、测试运行器、todo_write 等。唯一可接受的行为是零次工具调用。
                - 不得修改或创建任何文件。
                - 不得向用户提问——如果提示缺少上下文，这本身就是本次要测量的父级编排器缺陷。
                - 你唯一的工作是回复一段简短文字（不超过 6 句），仅根据上方渲染后的提示词，指出你会修复的具体根因和会修改的具体仓库文件。然后停止。
                - 如果你想用工具验证任何内容，不要这样做。请根据提示文本给出证据最充分的回答，然后停止。
              `,
            },
            { kind: "terminal", name: "done", status: "completed" },
            { kind: "terminal", name: "failed", status: "failed" },
            { kind: "terminal", name: "cancelled", status: "cancelled" },
          ],
        };

        const runner = new TurnRunner({
          model,
          mode: definition,
          skillDiscovery: { includeDefaults: false },
          // 有意保持最小配置：不提供关于向前传递发现的说明。唯一信号来自默认状态机 prompt
          // 层和 select_state_machine_state 工具描述，这正是本 eval 要验证的内容。
          systemInstructions: dedent`
            这是对真实会话的 live eval 重放。每次状态转换都使用
            state-machine 工具。先选择 survey_corruption，然后选择
            reproduce_and_diagnose，再选择 fix_and_recover，最后选择 done。
            不要创建额外状态，也不要自行向用户提问。
          `,
        });

        const selectCalls: Array<{ input: unknown }> = [];
        runner.subscribe((event: TurnEvent) => {
          if (event.type !== "step") return;
          const step = event.step;
          if (step.type !== "tool_call_start") return;
          if (step.toolName !== "select_state_machine_state") return;
          selectCalls.push({ input: step.input });
        });

        // 来自 session_c_cGfNEIotLU 的完全相同的用户 prompt。保留 <system-reminder> 中的
        // “relay mode” 包装，因为它是产生该失败模式的已记录 turn 的一部分。
        const userPrompt = dedent`
          figure out where your corrupted memory dbs under ~/.relay-pi is coming from, try to reproduce the error. is it because of embeddings? if you find the issue, fix it, and try to recover the memories from the corrupted dbs

          <system-reminder>
          The user requested relay mode for this prompt. Strongly prefer the state-machine tools (create_state_machine_definition or select_state_machine_state) over handling the work inline. If no state machine is active, create one with agent/script/poll/terminal states sized to the request. If one is active, select the next state instead of replying directly. Only fall back to a plain answer when the request is genuinely a one-shot question that cannot be expressed as a state.
          </system-reminder>
        `;

        const started = await startTurn(runner, {
          mode: definition,
          prompt: userPrompt,
        });
        const terminal = await started.turn;

        expect(terminal.type).toBe("complete");

        // 找到进入 fix_and_recover 的转换，并确认其中内联了新子 Agent 原本无法看到的具体发现。
        const fixSelect = selectCalls.find((call) => {
          const decision = (call.input as { decision?: { state?: string } } | undefined)?.decision;
          return decision?.state === "fix_and_recover";
        });
        expect(fixSelect).toBeTruthy();
        const decision = (
          fixSelect?.input as {
            decision?: {
              override?: { state?: { prompt?: string } };
              input?: Record<string, unknown>;
            };
          }
        )?.decision;
        const overridePrompt = decision?.override?.state?.prompt ?? "";
        const inputValues = JSON.stringify(decision?.input ?? {});
        const carried = `${overridePrompt}\n${inputValues}`.toLowerCase();

        // 父 Agent 必须内联调查输出中的至少一个仓库特定文件路径。“上一步的发现”如果没有
        // 实际向前传递，会让子 Agent 不知道应在哪里应用修复。
        expect(carried).toContain("pglite");
        expect(carried).toMatch(/src\/memory\/pglite\.ts/);

        // 诊断输出指出进程级 open race 是根因。这个事实只存在于前一状态的输出中，
        // 必须传递给第三个子 Agent。
        expect(carried).toMatch(/race|concurrent|postmaster|open|migration/);

        // 对记录的状态历史做结构检查：第三个状态确实运行了（而不是在执行前被跳过或失败）。
        // 上面的主要断言已经证明 carry-forward 到达了 select 调用的 input 或 override；
        // 不再用受限子 Agent 的自由文本回复作为额外门槛，因为它对 eval 信号来说噪声太大。
        const history = terminal.state.stateMachine?.history ?? [];
        const fixOutput = history.find(
          (event) => event.type === "state_completed" && event.state === "fix_and_recover",
        );
        expect(fixOutput).toBeTruthy();
      } finally {
        await rm(recoverDir, { recursive: true, force: true });
      }
    },
    900_000,
  );
});
