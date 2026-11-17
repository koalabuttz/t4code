import { Atom } from "effect/reactivity";

export const crewDraftBrief = Atom.family((_projectKey: string) =>
  Atom.make("").pipe(Atom.keepAlive),
);
export function readCrewCommand(text: string): { brief: string } | null {
  const match = /^\/(?:crew|swarm)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return match ? { brief: match[1]?.trim() ?? "" } : null;
}

export type CrewView =
  | "tasks"
  | "conversations"
  | "board"
  | "knowledge"
  | "context"
  | "roles"
  | "history";
export const crewSelectedInitiative = Atom.family((_projectKey: string) =>
  Atom.make<string | null>(null).pipe(Atom.keepAlive),
);
export const crewSelectedView = Atom.family((_projectKey: string) =>
  Atom.make<CrewView>("tasks").pipe(Atom.keepAlive),
);
