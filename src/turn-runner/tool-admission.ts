import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Compile } from "typebox/compile";

/** 在 SDK 强制转换参数或将参数值包含进错误之前进行验证。 */
const admittedTools = new WeakMap<AgentTool, AgentTool>();

export function admitToolArguments(tool: AgentTool): AgentTool {
  const cached = admittedTools.get(tool);
  if (cached) return cached;
  let validator: ReturnType<typeof Compile> | undefined;
  const prepare = tool.prepareArguments;
  function validate(value: unknown) {
    validator ??= Compile(tool.parameters);
    if (validator.Check(value)) return value;
    const diagnostics = [...validator.Errors(value)].slice(0, 4).map((error) => {
      const extras =
        "additionalProperties" in error.params ? error.params.additionalProperties : undefined;
      const path =
        error.keyword === "additionalProperties" && Array.isArray(extras)
          ? `${error.instancePath}/${String(extras[0]).replace(/~/g, "~0").replace(/\//g, "~1")}`
          : error.instancePath || "/";
      return `${path}: ${error.message}`;
    });
    throw new Error(`Invalid arguments for ${tool.name}: ${diagnostics.join("; ")}`.slice(0, 1200));
  }
  const admitted: AgentTool = {
    ...tool,
    prepareArguments: (value) => {
      // 工具的显式输入适配器属于其公共契约的一部分（例如
      // edit 接受单项替换）。只排除 SDK 的通用强制转换。
      return validate(prepare ? prepare(value) : value);
    },
  };
  admittedTools.set(tool, admitted);
  admittedTools.set(admitted, admitted);
  return admitted;
}
