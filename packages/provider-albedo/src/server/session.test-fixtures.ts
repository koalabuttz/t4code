import type * as Protocol from "./sessionProtocol.ts";

export const generation = "e0e_WR6iy5sG82Q_cbZBaw";
export const sessionId = "01a1e5b6-679d-70de-99b6-8b2886e4f501";

export const session = (): Protocol.Session => ({
  id: sessionId,
  creation: null,
  name: "Protocol fixture",
  workspace: "/workspace",
  parent_id: null,
  root_id: sessionId,
  role: "",
  started_by: null,
  address: null,
  depth: 0,
  closed: false,
  provider_profile: "fixture",
  model: "fixture-model",
  effort: "inherit",
  status: { phase: "idle", run_id: null, interrupt_requested: false, blocking_reason: null },
  cursor: { generation, sequence: 0 },
  current_progress: [],
  pending_inputs: [],
  input_order: 0,
  kernel: {
    instance_id: null,
    state: "none",
    stage: null,
    build: null,
    stale: false,
    staleness_reasons: [],
    live_job_count: 0,
    running_jobs: [],
  },
  usage: {
    model: null,
    observed_at: null,
    prompt_tokens: null,
    cached_prompt_tokens: null,
    cache_write_tokens: null,
    completion_tokens: null,
    total_tokens: null,
    context_window_tokens: null,
    elapsed_ms: null,
    tokens_per_second: null,
    cache_ttl_seconds: null,
    cache_fade: [],
  },
  history: { items: [], older: null, newer: null, high_water: 0 },
  active_output: [],
});

export const reset = (): Protocol.Batch => ({
  generation,
  cursor: 0,
  events: [{ type: "reset", data: { reason: "initial" } }],
  snapshot: session(),
});

export const textEvent = (sequence: number): Protocol.Event => ({
  type: "text",
  sequence,
  data: { run_id: "run-1", message_id: "message-1", text: "Hello 🌍" },
});
