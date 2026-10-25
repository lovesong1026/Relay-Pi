/**
 * 显式状态机示例。
 *
 * 为运行器提供一个包含 agent 状态和成功终态的具体状态机定义，
 * 然后请求运行这个流程。运行器会自动注入 "failed" 和 "cancelled"
 * 两个终止出口，因此定义中不需要显式写出它们。
 */

import { TurnRunner, type TurnRunnerConfig, type StateMachineDefinition } from "../src/index.js";

const definition: StateMachineDefinition = {
  name: "brief_writer",
  prompt: "当用户需要简短的书面简报、总结或建议时，使用此状态机。",
  states: [
    {
      kind: "agent",
      name: "write_brief",
      when: "需要为用户撰写简报。",
      prompt: "请针对用户的请求撰写一份简洁的简报。控制在120字以内，不要编辑文件。",
    },
    {
      kind: "terminal",
      name: "brief_finished",
      status: "completed",
      reason: "已完成用户要求的简报。",
    },
  ],
};

async function main() {
  const config: TurnRunnerConfig = {
    model: "opus",
    cwd: process.cwd(),
  };

  const runner = new TurnRunner(config);
  runner.subscribe((event) => {
    if (event.type === "state_machine") {
      console.log(`State: ${event.stateMachine.currentState ?? "(none)"}`);
    }
    if (event.type === "step") {
      console.log(event.step);
    }
  });

  await runner.start({ type: "start", mode: definition });
  const terminal = await runner.turn({
    type: "prompt",
    message: "请为高风险发布时使用功能开关写一份简短建议。",
    behavior: "follow_up",
  });

  console.log("\n--- State Machine Summary ---");
  console.log(`Status: ${terminal.state.status}`);
  console.log(`Current state: ${terminal.state.stateMachine?.currentState ?? "none"}`);
  if (terminal.type === "complete" && terminal.error) {
    console.error(`Error: ${terminal.error}`);
  }
}

main().catch(console.error);
