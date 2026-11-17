# Albedo collaboration routing

Checks which Python call a model chooses from Albedo's current T3 instructions: an existing Crew assignment uses `t3_team_delegate`, standalone T3 delegation uses `delegate_task`, and native helpers stay in Albedo. Ordinary work is a control.

```sh
cd evals
pnpm albedo-collaboration --out runs/albedo-before
pnpm albedo-collaboration --out runs/albedo-after --baseline runs/albedo-before/results.json
```

This is a text decision eval through an authenticated Codex CLI, not an Albedo execution test. It imports `promptWithInstructions` from source and requests a Python cell without executing it. Each sample is ephemeral, read-only, and has plugins, apps and hooks disabled. Native protocol and Crew execution are tested separately.

Flags: `--model` (default `gpt-6-luna`), `--samples` (default 3), repeatable `--case`, `--codex` (CLI path), `--out` and `--baseline`. Baselines must use the same model. Cases identify their source and rubric in `cases.ts`.

Grade `review.md` manually before opening `review-key.json`: a baseline comparison shuffles A/B independently per sample. A case fails if half or more of its samples violate its rubric. `results.json` retains code and model; transcripts retain token usage. The default run makes 12 small calls billed by the configured CLI account, with no separate shell simulator. No dollar cost is inferred from subscription usage.
