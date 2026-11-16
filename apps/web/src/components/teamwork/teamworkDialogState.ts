import { Atom } from "effect/reactivity";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { appAtomRegistry } from "~/rpc/atomRegistry";

export const teamworkDialogThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("teamwork:dialog-thread"),
);
export const openTeamworkDialog = (thread: ScopedThreadRef | null) =>
  appAtomRegistry.set(teamworkDialogThreadAtom, thread);
