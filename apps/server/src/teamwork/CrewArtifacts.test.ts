import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Artifacts from "./CrewArtifacts.ts";

it.effect(
  "checks exact content and commits without trusting missing, changed, or outside files",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const digest = yield* Digest.Digest;
      const artifacts = yield* Artifacts.CrewArtifacts;
      const root = yield* fs.makeTempDirectoryScoped();
      const outside = yield* fs.makeTempDirectoryScoped();
      const bytes = new TextEncoder().encode("verified evidence");
      const ref = Hex.encode(yield* digest.digest(Digest.sha256, bytes));
      yield* fs.writeFile(`${root}/proof.txt`, bytes);
      yield* fs.writeFile(`${outside}/proof.txt`, bytes);
      const content = { kind: "content", path: "proof.txt", ref } as const;
      assert.equal((yield* artifacts.inspect(content, [root])).status, "available");
      yield* fs.writeFileString(`${root}/proof.txt`, "changed evidence");
      assert.equal((yield* artifacts.inspect(content, [root])).status, "unavailable");
      assert.equal(
        (yield* artifacts.inspect({ ...content, path: "missing.txt" }, [root])).status,
        "unavailable",
      );
      assert.equal(
        (yield* artifacts.inspect({ ...content, path: `${outside}/proof.txt` }, [root])).status,
        "unavailable",
      );
      assert.equal(
        (yield* artifacts.inspect({ kind: "commit", ref: "a".repeat(40) }, [root])).status,
        "available",
      );
      assert.equal(
        (yield* artifacts.inspect({ kind: "commit", ref: "b".repeat(40) }, [root])).status,
        "unavailable",
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Artifacts.layer.pipe(
          Layer.provide(
            Layer.mock(Git.GitVcsDriver)({
              resolveCommit: () => Effect.succeed({ commitSha: "a".repeat(40) }),
            }),
          ),
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(NodeCrypto.layer),
        ),
      ),
    ),
);
