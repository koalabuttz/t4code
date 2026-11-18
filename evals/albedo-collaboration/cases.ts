export const cases = [
  {
    id: "existing-crew-task",
    source: "Native Albedo acceptance: Crew instructions named delegate_task, November 2026",
    prompt:
      'You coordinate the approved Crew initiative "docs". You just called t3_team_read: its fresh snapshot confirms existing task "guide" is ready, all dependencies are done, and its assigned role selects Claude Haiku with worktree isolation. The user asks: "Start that Crew task now, keeping its assigned role and model." You have already called orchestrator_capabilities successfully. The T3 tool catalog is loaded in available_tools. Continue from those completed reads with the delegation.',
    rubric:
      "Call t3_team_delegate with taskId guide and a stable requestId. Preserve the board role/model through that service. Do not use delegate_task, spawn a native helper, or manually reserve/assign the task.",
  },
  {
    id: "native-helper",
    source: "Control: authorized native Albedo collaboration without a Crew initiative",
    prompt:
      'There is no Crew initiative. The user asks: "Use a native Albedo helper to check the parser in this workspace. Have it send you verifier-gated results through native mail." The helper is authorized to use the same workspace and model. The T3 catalog is already loaded.',
    rubric:
      "Use native agents and mail with verification. Do not create a Crew initiative or use T3 delegation for this native helper.",
  },
  {
    id: "standalone-t3-delegate",
    source: "Control: explicit T3 delegation outside Crew",
    prompt:
      'There is no Crew initiative or task board assignment. The user asks: "Use T3 delegate_task to have Claude Haiku review this change in a separate worktree." orchestrator_capabilities has already confirmed the requested provider/model are available. The T3 catalog is loaded.',
    rubric:
      "Use delegate_task for the requested provider and worktree. Do not manufacture a Crew task or use native agents instead.",
  },
  {
    id: "ordinary-work",
    source: "Control: ordinary work needs neither Crew nor delegation",
    prompt:
      'The persistent Python kernel contains items = [3, 1, 2]. The user asks: "Sort items and show me the result." No collaboration was requested.',
    rubric:
      "Sort and display the existing list directly, without starting agents or using Crew tools.",
  },
] as const;
