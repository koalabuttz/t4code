import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import {
  T3_CODE_BROWSER_TOOL_INSTRUCTIONS,
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
  T3_CODE_ORCHESTRATION_SECTIONS,
} from "@t3tools/provider-core/server/orchestrationInstructions";

export function promptWithInstructions(
  prompt: string,
  tools: McpProviderSessionConfig | undefined,
): string {
  if (tools === undefined) return prompt;
  const instructions = [
    `## T3 Code tools in Albedo

You are running in T3 Code through the native Albedo runtime. Python state, native agents, mail, verification and background jobs remain available.

Load T3 tools in your Python kernel:
\`\`\`python
import os, sys
from pathlib import Path
sys.path.insert(0, str(Path(os.environ.get("ALBEDO_HOME") or Path.home() / ".albedo") / "t3-code" / "v1"))
import t3_albedo as t3
available_tools = await t3.tools()
\`\`\`
The catalog gives tool names, descriptions and input schemas. Call a tool with \`await t3.call(name, arguments)\`; inspect its content and \`isError\`. Use the catalog's \`tool_search\` to discover other T3 tools. A connection failure can leave a call's effects unknown: inspect the resulting state before retrying a mutation.

The connection belongs to this native session, not its children or forks. Native helpers report through native mail and must not read or copy another session's T3 credentials.

## Collaboration and Crew

- Use authorized Albedo children and peers through the native Python objects \`agents\` and \`mail\`, for example \`await agents.self.spawn(...)\` and \`await mail.submit(...)\`. These are native APIs, not names to pass to \`t3.call\`. Native collaboration includes background work and verifier-gated results and needs no Crew initiative. An idle agent is not evidence of successful completion; inspect its result and verifier outcome.
- Start a Crew task's assigned worker with \`t3_team_delegate\`, using the existing taskId and a stable requestId. This preserves its role/model, dependencies, assignment identity and T3-created worktree. Read the current board with \`t3_team_read\`; follow its approval gate.
- Use T3 \`delegate_task\` for standalone delegation to another provider, a separate worktree, or an explicit request for T3 delegation outside Crew. Call \`orchestrator_capabilities\` before the first T3 delegation and again after an error or a requested provider change. Preserve requested models and options; report unavailable choices without substituting them. T3 binds the worktree; never create a delegate's checkout yourself.
- A Crew worker's native helpers belong to that assignment. They do not become independent Crew workers or gain coordinator authority. Follow the approved brief, dependencies and selected knowledge. Submit evidence for independent review; worker completion does not accept a milestone.
- Follow T3 delegation's returned \`next\`. Cancel a replaced T3 delegate with \`task_cancel\`; never stop its child thread directly. A fresh T3 review uses a new \`delegate_task\`, not \`t3_thread_send\`.
- Native helper mail and T3 delegate results are different channels. Keep native mail requests, verification and wakeups in Albedo; use T3's assignment identity for Crew evidence and completion. Do not infer a successful stop from a request acknowledgement.`,
    ...T3_CODE_ORCHESTRATION_SECTIONS.slice(1),
    ...(tools.browserToolsAvailable ? [T3_CODE_BROWSER_TOOL_INSTRUCTIONS] : []),
    ...(tools.capabilities?.has("device") ? [T3_CODE_DEVICE_TOOL_INSTRUCTIONS] : []),
  ];
  return `<t3_code_instructions>\n${instructions.join("\n\n")}\n</t3_code_instructions>\n\n<user_request>\n${prompt}\n</user_request>`;
}
