const { execFileSync } = require("node:child_process");
const { appendFileSync } = require("node:fs");

const branch = "automation/upstream-sync";

function prepareSync(cwd, { main, upstream, previous }) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const contains = (ancestor, descendant) => {
    try {
      git("merge-base", "--is-ancestor", ancestor, descendant);
      return true;
    } catch (error) {
      if (error.status === 1) return false;
      throw error;
    }
  };
  if (git("status", "--porcelain") !== "") throw new Error("Sync requires a clean checkout.");
  const base = git("rev-parse", main);
  const source = git("rev-parse", upstream);
  if (contains(source, base)) return { changed: false, updated: false, base, source };
  const start = previous && !contains(previous, base) ? previous : base;
  git("switch", "--detach", start);
  try {
    git("merge", "--no-edit", base);
    git("merge", "--no-edit", source);
  } catch (error) {
    const conflicts = git("diff", "--name-only", "--diff-filter=U");
    git("merge", "--abort");
    throw new Error(`Upstream sync needs manual resolution; nothing was pushed.\n${conflicts}`, {
      cause: error,
    });
  }
  const head = git("rev-parse", "HEAD");
  return { changed: true, updated: head !== previous, base, source, head };
}

if (require.main === module) {
  if (process.env.GITHUB_REPOSITORY !== "koalabuttz/t4code") {
    throw new Error("This sync is configured only for koalabuttz/t4code.");
  }
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
  const previous = git("for-each-ref", "--format=%(objectname)", `refs/remotes/origin/${branch}`);
  const result = prepareSync(process.cwd(), {
    main: "origin/main",
    upstream: "refs/remotes/upstream/main",
    previous: previous || undefined,
  });
  if (result.changed) {
    git("fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main");
    if (git("rev-parse", "origin/main") !== result.base) {
      throw new Error("Main advanced during sync; rerun with its new head. Nothing was pushed.");
    }
    // A normal push rejects another writer instead of replacing their work.
    if (result.updated) git("push", "origin", `HEAD:refs/heads/${branch}`);
  }
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `changed=${result.changed}\nupdated=${result.updated}\n`,
  );
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    result.changed
      ? `Prepared ${result.head} from fork ${result.base} and upstream ${result.source}. Manual PR merge is required.\n`
      : `Fork main already contains upstream ${result.source}.\n`,
  );
}

module.exports = { prepareSync };
