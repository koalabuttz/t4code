import { type EnvironmentId, type UnifiedSettings, UsageLimitSourceId } from "@t3tools/contracts";
import { USAGE_SOURCE_PRESETS } from "@t3tools/shared/usageLimits";
import { T, useGT, Var } from "gt-react";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { AddUsageLimitSourceDialog } from "./AddUsageLimitSourceDialog";
import { useSearchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function UsageProviderSettings({
  environmentId,
  environmentLabel,
  sources,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly sources: UnifiedSettings["usageLimitSources"];
  readonly readOnly: boolean;
}) {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<UsageLimitSourceId | null>(null);
  const entries = Object.entries(sources);
  const editedSource = editing ? sources[editing] : undefined;

  return (
    <>
      <SettingsSection
        {...searchableSetting("usage-providers")}
        headerAction={
          !readOnly ? (
            <Button size="xs" variant="outline" onClick={() => setAdding(true)}>
              <PlusIcon className="size-3" aria-hidden />
              <T>Add source</T>
            </Button>
          ) : null
        }
      >
        {entries.length === 0 ? (
          <SettingsRow title={gt("No usage sources configured.")} />
        ) : (
          entries.map(([id, source]) => {
            const label = source.label?.trim() || source.url;
            const service = USAGE_SOURCE_PRESETS[source.kind].label;
            return (
              <SettingsRow
                key={id}
                title={label}
                description={
                  <span className="break-all">
                    {source.enabled ? service : gt("{name} · Disabled", { name: service })}
                    {label !== source.url ? ` · ${source.url}` : ""}
                  </span>
                }
                control={
                  !readOnly ? (
                    <div className="flex gap-2">
                      {source.kind === "anthropic" ? (
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() => setEditing(UsageLimitSourceId.make(id))}
                        >
                          <T>Update session</T>
                        </Button>
                      ) : null}
                      <RemoveUsageProviderButton
                        label={label}
                        onConfirm={() => updateSettings({ usageLimitSources: { [id]: null } })}
                      />
                    </div>
                  ) : null
                }
              />
            );
          })
        )}
      </SettingsSection>
      {(adding || editedSource) && !readOnly ? (
        <AddUsageLimitSourceDialog
          key={editing ?? "new"}
          open
          onOpenChange={(open) => {
            if (!open) {
              setAdding(false);
              setEditing(null);
            }
          }}
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          sources={sources}
          {...(editing && editedSource
            ? {
                initialSource: { id: editing, config: editedSource },
              }
            : {})}
        />
      ) : null}
    </>
  );
}

function RemoveUsageProviderButton({
  label,
  onConfirm,
}: {
  readonly label: string;
  readonly onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        <T>Remove</T>
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <T>
                Remove <Var>{label}</Var>?
              </T>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <T>
                The saved credential is deleted from this server and this source leaves the Limits
                view. You can add it again at any time.
              </T>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              <T>Remove source</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
