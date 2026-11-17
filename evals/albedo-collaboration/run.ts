#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { promptWithInstructions } from "../../packages/provider-albedo/src/server/instructions.ts";
import { cases } from "./cases.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string", default: "gpt-6-luna" },
    baseline: { type: "string" },
    case: { type: "string", multiple: true },
    samples: { type: "string", default: "3" },
    codex: { type: "string", default: "codex" },
  },
});
if (!values.out) throw new Error("Use --out <directory> [--baseline <results.json>].");
const samples = Number(values.samples);
if (!Number.isSafeInteger(samples) || samples < 1) throw new Error("--samples must be positive.");
const selected = cases.filter((entry) => !values.case || values.case.includes(entry.id));
if (!selected.length) throw new Error("No case matches --case.");
const out = NodePath.resolve(values.out);
NodeFS.mkdirSync(out, { recursive: true });
const resultSchema = Schema.Struct({ code: Schema.String });
const decodeReply = Schema.decodeSync(Schema.fromJsonString(resultSchema));
const Row = Schema.Struct({
  id: Schema.String,
  sample: Schema.Number,
  model: Schema.String,
  code: Schema.String,
});
const baseline = values.baseline
  ? Schema.decodeSync(Schema.fromJsonString(Schema.Array(Row)))(
      NodeFS.readFileSync(values.baseline, "utf8"),
    )
  : [];
if (baseline.some((row) => row.model !== values.model))
  throw new Error("Compare runs on the same model.");
const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-albedo-eval-"));
const schemaPath = NodePath.join(cwd, "schema.json");
NodeFS.writeFileSync(
  schemaPath,
  JSON.stringify({
    type: "object",
    properties: { code: { type: "string" } },
    required: ["code"],
    additionalProperties: false,
  }),
);
const rows: Array<typeof Row.Type> = [];
const review: string[] = [];
const key: Record<string, string> = {};
for (const entry of selected) {
  for (let sample = 1; sample <= samples; sample++) {
    const name = `${entry.id}-${sample}`;
    const outputPath = NodePath.join(cwd, "reply.json");
    const prompt = promptWithInstructions(
      `${entry.prompt}\nWrite the next single Python cell you would execute. Return its code; do not execute it or use any tools in this evaluation.`,
      {
        environmentId: EnvironmentId.make("eval-environment"),
        threadId: ThreadId.make("eval-thread"),
        providerSessionId: "eval-session",
        providerInstanceId: ProviderInstanceId.make("eval-albedo"),
        endpoint: "http://localhost/unused",
        authorizationHeader: "unused",
        browserToolsAvailable: false,
      },
    );
    const run = NodeChildProcess.spawnSync(
      values.codex,
      [
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--model",
        values.model,
        "--config",
        "features.plugins=false",
        "--config",
        "features.apps=false",
        "--config",
        "features.hooks=false",
        "--config",
        "features.codex_hooks=false",
        "--config",
        'model_reasoning_effort="low"',
        "--output-schema",
        schemaPath,
        "--output-last-message",
        outputPath,
        "--json",
        "-",
      ],
      { cwd, input: prompt, encoding: "utf8", windowsHide: true, timeout: 180_000 },
    );
    NodeFS.writeFileSync(NodePath.join(out, `${name}.jsonl`), run.stdout ?? "");
    if (run.error || run.status !== 0)
      throw new Error(`Eval ${name} failed: ${run.error?.message ?? run.stderr}`);
    const { code } = decodeReply(NodeFS.readFileSync(outputPath, "utf8"));
    rows.push({ id: entry.id, sample, model: values.model, code });
    NodeFS.writeFileSync(NodePath.join(out, "results.json"), JSON.stringify(rows, null, 2));
    const previous = baseline.find((row) => row.id === entry.id && row.sample === sample);
    const beforeFirst = NodeCrypto.randomInt(2) === 0;
    const choices = previous
      ? beforeFirst
        ? [previous.code, code]
        : [code, previous.code]
      : [code];
    key[name] = previous ? (beforeFirst ? "B" : "A") : "A";
    review.push(
      `## ${name}\n\n${entry.rubric}\n\n` +
        choices
          .map((value, i) => `### ${String.fromCharCode(65 + i)}\n\n\`\`\`python\n${value}\n\`\`\``)
          .join("\n\n"),
    );
    process.stdout.write(`${name}: recorded for human review\n`);
  }
}
NodeFS.writeFileSync(NodePath.join(out, "review.md"), review.join("\n\n"));
NodeFS.writeFileSync(NodePath.join(out, "review-key.json"), JSON.stringify(key, null, 2));
NodeFS.writeFileSync(
  NodePath.join(out, "summary.md"),
  `${rows.length} samples on ${values.model}. Human grading: review.md; mapping: review-key.json.\nToken usage is in each transcript's turn.completed event. CLI billing is account-specific; no dollar estimate is inferred.\n`,
);
NodeFS.unlinkSync(NodePath.join(cwd, "reply.json"));
NodeFS.unlinkSync(schemaPath);
NodeFS.rmdirSync(cwd);
