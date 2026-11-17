import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";
import type { AcpAdapterV2SubagentUpdate } from "@t3tools/provider-acp/server/adapter";

const decodeAgentInput = Schema.decodeUnknownOption(
  Schema.Struct({
    prompt: Schema.String,
    description: Schema.optionalKey(Schema.String),
    model: Schema.optionalKey(Schema.String),
    run_in_background: Schema.optionalKey(Schema.Boolean),
  }),
);
const decodeAsyncResponse = Schema.decodeUnknownOption(
  Schema.Struct({
    claudeCode: Schema.Struct({ toolResponse: Schema.Struct({ isAsync: Schema.Boolean }) }),
  }),
);

export function isClaudeProvisionalSubagentTool(tool: AcpToolCallState): boolean {
  return (
    (tool.data.name === "Agent" || tool.data.name === "Task") &&
    tool.status !== "failed" &&
    tool.status !== "completed" &&
    Option.isNone(decodeAgentInput(tool.data.rawInput))
  );
}

export function extractClaudeSubagentUpdate(
  tool: AcpToolCallState,
): AcpAdapterV2SubagentUpdate | undefined {
  if (tool.data.name !== "Agent" && tool.data.name !== "Task") return;
  const input = decodeAgentInput(tool.data.rawInput);
  if (Option.isNone(input)) return;
  const response = decodeAsyncResponse(tool.data.meta);
  const background =
    input.value.run_in_background === true ||
    (Option.isSome(response) && response.value.claudeCode.toolResponse.isAsync);
  return {
    nativeTaskId: tool.toolCallId,
    childSessionId: null,
    prompt: input.value.prompt,
    title: input.value.description ?? null,
    model: input.value.model ?? null,
    status:
      tool.status === "failed"
        ? "failed"
        : tool.status === "completed" && !background
          ? "completed"
          : "running",
    result: null,
  };
}
