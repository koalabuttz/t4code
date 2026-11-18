import type { TeamworkArtifact, TeamworkArtifactAvailability } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";
import * as Git from "../vcs/GitVcsDriver.ts";

export class CrewArtifacts extends Context.Service<
  CrewArtifacts,
  {
    readonly inspect: (
      artifact: typeof TeamworkArtifact.Type,
      roots: readonly string[],
    ) => Effect.Effect<typeof TeamworkArtifactAvailability.Type>;
  }
>()("t3/teamwork/CrewArtifacts") {}

export const layer = Layer.effect(
  CrewArtifacts,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const digest = yield* Digest.Digest;
    const git = yield* Git.GitVcsDriver;
    return CrewArtifacts.of({
      inspect: Effect.fn("CrewArtifacts.inspect")(
        function* (artifact, roots) {
          if (artifact.kind === "commit") {
            for (const cwd of new Set(roots)) {
              const available = yield* git.resolveCommit({ cwd, revision: artifact.ref }).pipe(
                Effect.map((value) => value.commitSha === artifact.ref),
                Effect.orElseSucceed(() => false),
              );
              if (available)
                return {
                  status: "available" as const,
                  detail: "The exact submitted commit is available in the project repository.",
                };
            }
            return {
              status: "unavailable" as const,
              detail:
                "The submitted commit could not be read from the project or worker repository. It may have been removed or the repository may be unavailable.",
            };
          }
          for (const root of new Set(roots)) {
            const physicalRoot = yield* fs.realPath(root).pipe(Effect.option);
            if (physicalRoot._tag === "None") continue;
            const candidate = yield* fs
              .realPath(path.resolve(root, artifact.path))
              .pipe(Effect.option);
            if (candidate._tag === "None") continue;
            const relative = path.relative(physicalRoot.value, candidate.value);
            if (
              path.isAbsolute(relative) ||
              relative === ".." ||
              relative.startsWith(`..${path.sep}`)
            )
              continue;
            const info = yield* fs.stat(candidate.value);
            if (info.type !== "File") continue;
            if (info.size > 16 * 1024 * 1024)
              return {
                status: "unchecked" as const,
                detail:
                  "This artifact exceeds the 16 MiB inspection limit. Verify its SHA-256 manually.",
              };
            const bytes = yield* fs.readFile(candidate.value);
            const hash = Hex.encode(yield* digest.digest(Digest.sha256, bytes));
            if (hash === artifact.ref)
              return {
                status: "available" as const,
                detail: "The file matches the exact submitted SHA-256.",
              };
          }
          return {
            status: "unavailable" as const,
            detail:
              "No file matching the submitted SHA-256 is available within the project or worker workspace. It may have changed or been removed.",
          };
        },
        Effect.orElseSucceed(() => ({
          status: "unchecked" as const,
          detail: "The artifact could not be inspected. Check workspace access and try again.",
        })),
      ),
    });
  }),
);
