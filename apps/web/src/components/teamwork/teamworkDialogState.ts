import { Atom } from "effect/reactivity";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { prepareCrewEntry } from "@t3tools/client-runtime/state/crew";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readThreadShell } from "../../state/entities";

export const teamworkDialogThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("teamwork:dialog-thread"),
);
export const openTeamworkDialog = (thread: ScopedThreadRef | null) => {
  const shell = thread ? readThreadShell(thread) : null;
  if (thread && shell)
    prepareCrewEntry(
      appAtomRegistry,
      {
        environmentId: thread.environmentId,
        projectId: shell.projectId,
      },
      { threadId: thread.threadId },
    );
  appAtomRegistry.set(teamworkDialogThreadAtom, thread);
};
