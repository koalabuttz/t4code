import {
  type EnvironmentId,
  type SecretReference,
  type UnifiedSettings,
  UsageLimitSourceKind,
} from "@t3tools/contracts";
import { USAGE_SOURCE_PRESETS } from "@t3tools/shared/usageLimits";
import { useId, useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { sourceIdFromUrl } from "./AddUsageLimitSourceDialog.logic";
import { SecretSourceInput, useSecretSources } from "./SecretSourceInput";
import { Label } from "../ui/label";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";

/** Send the management key once to server secret storage; settings retain only a redaction marker. */
export function AddUsageLimitSourceDialog({
  open,
  onOpenChange,
  environmentId,
  environmentLabel,
  sources,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly sources: UnifiedSettings["usageLimitSources"];
}) {
  const formId = useId();
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [kind, setKind] = useState<UsageLimitSourceKind>("cliproxy");
  const secretSources = useSecretSources(environmentId);
  const [keyDraft, setKeyDraft] = useState<string | SecretReference>("");
  const [keyValid, setKeyValid] = useState(true);
  const managementKey = typeof keyDraft === "string" ? keyDraft.trim() : keyDraft;
  const trimmedUrl = kind === "cliproxy" ? url.trim() : USAGE_SOURCE_PRESETS[kind].url;
  const canSave = keyValid && trimmedUrl.length > 0 && managementKey !== "";

  const reset = () => {
    setLabel("");
    setUrl("");
    setKeyDraft("");
    setKeyValid(true);
    setKind("cliproxy");
  };

  const save = () => {
    if (!canSave) return;
    const id = sourceIdFromUrl(trimmedUrl, sources, kind);
    updateSettings({
      usageLimitSources: {
        [id]: {
          kind,
          ...(label.trim() || kind !== "cliproxy"
            ? { label: label.trim() || USAGE_SOURCE_PRESETS[kind].label }
            : {}),
          url: trimmedUrl,
          managementKey,
          enabled: true,
        },
      },
    });
    reset();
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add a usage source</DialogTitle>
          <DialogDescription>
            Show account balances or quotas on {environmentLabel}. The key stays on that server.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="usage-source-kind">Service</Label>
              <Select
                value={kind}
                onValueChange={(value) => {
                  if (value) {
                    setKind(value);
                    setKeyDraft("");
                    setKeyValid(true);
                  }
                }}
              >
                <SelectTrigger id="usage-source-kind">
                  <SelectValue>{USAGE_SOURCE_PRESETS[kind].label}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {UsageLimitSourceKind.literals.map((value) => (
                    <SelectItem key={value} value={value}>
                      {USAGE_SOURCE_PRESETS[value].label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            {kind === "cliproxy" ? (
              <div className="grid gap-1.5">
                <Label htmlFor="usage-source-url">Hub URL</Label>
                <Input
                  id="usage-source-url"
                  placeholder="https://hub.example.ts.net:8318"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  autoFocus
                />
              </div>
            ) : null}
            <div className="grid gap-1.5">
              <Label htmlFor="usage-source-key">
                {kind === "cliproxy" ? "Management key" : "API key"}
              </Label>
              <SecretSourceInput
                id="usage-source-key"
                aria-label={kind === "cliproxy" ? "Management key" : "API key"}
                value={keyDraft}
                sources={secretSources}
                environmentId={environmentId}
                onChange={(event) => setKeyDraft(event.target.value)}
                onSecretChange={(secret) => setKeyDraft(secret ?? "")}
                onValidityChange={setKeyValid}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="usage-source-label">Label (optional)</Label>
              <Input
                id="usage-source-label"
                placeholder={
                  kind === "cliproxy"
                    ? "Defaults to the hub's host name"
                    : USAGE_SOURCE_PRESETS[kind].label
                }
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </div>
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button
            variant="outline"
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={!canSave}>
            Add source
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
