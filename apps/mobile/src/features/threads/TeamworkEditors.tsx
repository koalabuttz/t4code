import { useState } from "react";
import { View } from "react-native";
import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ModelSelection,
  TeamworkAction,
  TeamworkSnapshot,
  TeamworkTask,
} from "@t3tools/contracts";
import { AppText, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { serverEnvironment } from "../../state/server";
import { uuidv4 } from "../../lib/uuid";

interface EditorProps {
  state: TeamworkSnapshot;
  disabled: boolean;
  act: (action: TeamworkAction) => Promise<boolean>;
}

export function TeamworkTaskEditor({
  state,
  initiativeId,
  existing,
  disabled,
  act,
}: EditorProps & { initiativeId: string; existing?: TeamworkTask }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(existing?.title ?? "");
  const [brief, setBrief] = useState(existing?.brief ?? "");
  const [criteria, setCriteria] = useState(existing?.criteria ?? "");
  const [roleId, setRoleId] = useState<string | null>(existing?.roleId ?? null);
  const [milestoneId, setMilestoneId] = useState<string | null>(existing?.milestoneId ?? null);
  const [dependencies, setDependencies] = useState<readonly string[]>(existing?.dependencies ?? []);
  const [knowledgeIds, setKnowledgeIds] = useState<readonly string[]>(existing?.knowledgeIds ?? []);
  return (
    <View className="gap-2">
      <Button label={existing ? "Edit task" : "Add task"} onPress={() => setOpen(!open)} />
      {open && (
        <>
          <AppTextInput
            accessibilityLabel="Task title"
            placeholder="Task title"
            value={title}
            onChangeText={setTitle}
            maxLength={160}
          />
          <AppTextInput
            accessibilityLabel="Task brief"
            placeholder="Bounded assignment"
            value={brief}
            onChangeText={setBrief}
            multiline
            maxLength={12000}
          />
          <AppTextInput
            accessibilityLabel="Acceptance criteria"
            placeholder="Evidence required"
            value={criteria}
            onChangeText={setCriteria}
            multiline
            maxLength={12000}
          />
          <AppText>Worker role</AppText>
          <Button
            label="Inherit coordinator model"
            tone={roleId === null ? "primary" : "secondary"}
            onPress={() => setRoleId(null)}
          />
          {state.roles.map((r) => (
            <Button
              key={r.id}
              label={r.name}
              tone={roleId === r.id ? "primary" : "secondary"}
              onPress={() => setRoleId(r.id)}
            />
          ))}
          <AppText>Milestone</AppText>
          <Button
            label="No milestone"
            tone={milestoneId === null ? "primary" : "secondary"}
            onPress={() => setMilestoneId(null)}
          />
          {state.initiatives
            .find((i) => i.id === initiativeId)
            ?.milestones.map((m) => (
              <Button
                key={m.id}
                label={m.title}
                tone={milestoneId === m.id ? "primary" : "secondary"}
                onPress={() => setMilestoneId(m.id)}
              />
            ))}
          <AppText>Wait for tasks</AppText>
          {state.tasks
            .filter((t) => t.initiativeId === initiativeId && t.id !== existing?.id)
            .map((t) => (
              <Button
                key={t.id}
                label={t.title}
                tone={dependencies.includes(t.id) ? "primary" : "secondary"}
                onPress={() =>
                  setDependencies(
                    dependencies.includes(t.id)
                      ? dependencies.filter((id) => id !== t.id)
                      : [...dependencies, t.id],
                  )
                }
              />
            ))}
          <AppText>Knowledge to include</AppText>
          {state.knowledge.map((k) => (
            <Button
              key={k.id}
              label={k.title}
              tone={knowledgeIds.includes(k.id) ? "primary" : "secondary"}
              onPress={() =>
                setKnowledgeIds(
                  knowledgeIds.includes(k.id)
                    ? knowledgeIds.filter((id) => id !== k.id)
                    : [...knowledgeIds, k.id],
                )
              }
            />
          ))}
          <Button
            label="Save task"
            disabled={disabled || !title.trim() || !brief.trim() || !criteria.trim()}
            onPress={async () => {
              if (
                await act({
                  type: existing ? "task.edit" : "task.create",
                  id: existing?.id ?? uuidv4(),
                  initiativeId,
                  title,
                  brief,
                  criteria,
                  roleId,
                  milestoneId,
                  dependencies,
                  knowledgeIds,
                })
              ) {
                setOpen(false);
                if (!existing) {
                  setTitle("");
                  setBrief("");
                  setCriteria("");
                  setDependencies([]);
                  setKnowledgeIds([]);
                }
              }
            }}
          />
        </>
      )}
    </View>
  );
}

export function TeamworkBriefEditor({
  initiative,
  supportsDependencies,
  disabled,
  act,
}: Pick<EditorProps, "disabled" | "act"> & {
  initiative: TeamworkSnapshot["initiatives"][number];
  supportsDependencies: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(initiative.title);
  const [brief, setBrief] = useState(initiative.brief);
  const [milestone, setMilestone] = useState("");
  const [criteria, setCriteria] = useState("");
  const [dependencies, setDependencies] = useState<readonly string[]>([]);
  return (
    <View className="gap-2">
      <Button label="Edit brief and milestones" onPress={() => setOpen(!open)} />
      {open && (
        <>
          <AppTextInput
            accessibilityLabel="Edit initiative title"
            value={title}
            onChangeText={setTitle}
            maxLength={160}
          />
          <AppTextInput
            accessibilityLabel="Edit initiative brief"
            value={brief}
            onChangeText={setBrief}
            multiline
            maxLength={12000}
          />
          <AppText>
            Changing the brief stops workers and requires a fresh approval or resume.
          </AppText>
          <Button
            label="Save brief"
            disabled={disabled || !title.trim() || !brief.trim()}
            onPress={() =>
              void act({
                type: "initiative.edit",
                id: initiative.id,
                title,
                brief,
                mode: initiative.mode,
              })
            }
          />
          <AppTextInput
            accessibilityLabel="Milestone title"
            placeholder="Milestone"
            value={milestone}
            onChangeText={setMilestone}
            maxLength={160}
          />
          <AppTextInput
            accessibilityLabel="Milestone criteria"
            placeholder="Acceptance criteria"
            value={criteria}
            onChangeText={setCriteria}
            multiline
            maxLength={12000}
          />
          {supportsDependencies && initiative.milestones.length > 0 && (
            <View className="gap-2">
              <AppText>Wait for verified milestones</AppText>
              {initiative.milestones.map((m) => (
                <Button
                  key={m.id}
                  label={`${dependencies.includes(m.id) ? "✓ " : ""}${m.title}`}
                  tone={dependencies.includes(m.id) ? "primary" : "secondary"}
                  onPress={() =>
                    setDependencies(
                      dependencies.includes(m.id)
                        ? dependencies.filter((id) => id !== m.id)
                        : [...dependencies, m.id],
                    )
                  }
                />
              ))}
            </View>
          )}
          <Button
            label="Add milestone"
            disabled={disabled || !milestone.trim() || !criteria.trim()}
            onPress={async () => {
              if (
                await act({
                  type: "milestone.save",
                  initiativeId: initiative.id,
                  milestone: {
                    id: uuidv4(),
                    title: milestone,
                    criteria,
                    accepted: false,
                    ...(supportsDependencies ? { dependencies } : {}),
                  },
                })
              ) {
                setMilestone("");
                setCriteria("");
                setDependencies([]);
              }
            }}
          />
        </>
      )}
    </View>
  );
}

export function TeamworkRoles({
  state,
  environmentId,
  disabled,
  act,
}: EditorProps & { environmentId: EnvironmentId }) {
  const [open, setOpen] = useState(false);
  const [id, setId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? [];
  return (
    <View className="gap-2">
      <Button label="Team roles" onPress={() => setOpen(!open)} />
      {open && (
        <>
          {state.roles.map((r) => (
            <View key={r.id} className="gap-2 rounded-2xl bg-secondary p-4">
              <AppText>
                {r.name} · {r.modelSelection?.model ?? "Inherits coordinator model"}
              </AppText>
              <AppText>{r.instructions}</AppText>
              <Button
                label="Edit role"
                disabled={disabled}
                onPress={() => {
                  setId(r.id);
                  setName(r.name);
                  setInstructions(r.instructions);
                  setSelection(r.modelSelection);
                }}
              />
              <Button
                label="Remove role"
                disabled={disabled}
                onPress={() => void act({ type: "role.remove", id: r.id })}
              />
            </View>
          ))}
          <AppTextInput
            accessibilityLabel="Role name"
            placeholder="Reviewer, builder, researcher…"
            value={name}
            onChangeText={setName}
            maxLength={160}
          />
          <AppTextInput
            accessibilityLabel="Role instructions"
            placeholder="Responsibilities"
            value={instructions}
            onChangeText={setInstructions}
            multiline
            maxLength={12000}
          />
          <AppText>Worker model: {selection?.model ?? "Inherit coordinator model"}</AppText>
          <Button label="Inherit coordinator model" onPress={() => setSelection(null)} />
          {providers.flatMap((p) =>
            p.models.map((m) => (
              <Button
                key={`${p.instanceId}/${m.slug}`}
                label={`${p.displayName} · ${m.name ?? m.slug}`}
                tone={
                  selection?.instanceId === p.instanceId && selection.model === m.slug
                    ? "primary"
                    : "secondary"
                }
                onPress={() => setSelection({ instanceId: p.instanceId, model: m.slug })}
              />
            )),
          )}
          <Button
            label="Save role"
            disabled={disabled || !name.trim() || !instructions.trim()}
            onPress={async () => {
              if (
                await act({
                  type: "role.save",
                  role: { id: id ?? uuidv4(), name, instructions, modelSelection: selection },
                })
              ) {
                setId(null);
                setName("");
                setInstructions("");
                setSelection(null);
              }
            }}
          />
        </>
      )}
    </View>
  );
}
