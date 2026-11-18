const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { prepareSync } = require("./sync-upstream.cjs");

function fixture(t) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "t3-sync-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Sync test");
  git("config", "user.email", "sync@example.test");
  git("config", "core.hooksPath", path.join(cwd, "no-hooks"));
  const commit = (file, content) => {
    writeFileSync(path.join(cwd, file), content);
    git("add", file);
    git("commit", "-m", file);
    return git("rev-parse", "HEAD");
  };
  commit("shared.txt", "baseline\n");
  git("branch", "upstream");
  return { cwd, git, commit };
}

test("preserves fork features and manual sync edits across repeated upstream updates", (t) => {
  const { cwd, git, commit } = fixture(t);
  commit("crew.txt", "Crew\n");
  git("switch", "upstream");
  commit("upstream.txt", "first\n");
  const first = prepareSync(cwd, { main: "main", upstream: "upstream" });
  assert.equal(first.changed, true);
  git("switch", "-c", "sync");
  commit("resolution.txt", "manual integration adjustment\n");
  git("switch", "main");
  commit("albedo.txt", "Albedo\n");
  git("switch", "upstream");
  commit("upstream.txt", "second\n");
  const second = prepareSync(cwd, { main: "main", upstream: "upstream", previous: "sync" });
  assert.equal(git("show", "HEAD:crew.txt"), "Crew");
  assert.equal(git("show", "HEAD:albedo.txt"), "Albedo");
  assert.equal(git("show", "HEAD:resolution.txt"), "manual integration adjustment");
  assert.equal(git("show", "HEAD:upstream.txt"), "second");
  const repeated = prepareSync(cwd, { main: "main", upstream: "upstream", previous: second.head });
  assert.equal(repeated.head, second.head);
  assert.equal(repeated.updated, false);
  git("switch", "main");
  git("merge", "--ff-only", second.head);
  assert.equal(prepareSync(cwd, { main: "main", upstream: "upstream" }).changed, false);
});

test("leaves published branches unchanged on conflicts and refuses dirty checkouts", (t) => {
  const { cwd, git, commit } = fixture(t);
  const main = commit("shared.txt", "fork decision\n");
  git("switch", "upstream");
  const upstream = commit("shared.txt", "upstream decision\n");
  assert.throws(
    () => prepareSync(cwd, { main: "main", upstream: "upstream" }),
    /manual resolution/,
  );
  assert.equal(git("rev-parse", "main"), main);
  assert.equal(git("rev-parse", "upstream"), upstream);
  assert.equal(git("status", "--porcelain"), "");
  writeFileSync(path.join(cwd, "local.txt"), "uncommitted work");
  assert.throws(() => prepareSync(cwd, { main: "main", upstream: "upstream" }), /clean checkout/);
});
