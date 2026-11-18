import {
  type EnvironmentId,
  type SecretReference,
  type UnifiedSettings,
  type UsageLimitSourceId,
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
  initialSource,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly sources: UnifiedSettings["usageLimitSources"];
  readonly initialSource?: {
    readonly id: UsageLimitSourceId;
    readonly config: UnifiedSettings["usageLimitSources"][UsageLimitSourceId];
  };
}) {
  const formId = useId();
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [label, setLabel] = useState(initialSource?.config.label ?? "");
  const [url, setUrl] = useState(initialSource?.config.url ?? "");
  const [kind, setKind] = useState<UsageLimitSourceKind>(initialSource?.config.kind ?? "cliproxy");
  const [organizationId, setOrganizationId] = useState(initialSource?.config.organizationId ?? "");
  const secretSources = useSecretSources(environmentId);
  const [keyDraft, setKeyDraft] = useState<string | SecretReference>("");
  const [keyValid, setKeyValid] = useState(true);
  const managementKey = typeof keyDraft === "string" ? keyDraft.trim() : keyDraft;
  const trimmedUrl = kind === "cliproxy" ? url.trim() : USAGE_SOURCE_PRESETS[kind].url;
  const canSave = keyValid && trimmedUrl.length > 0 && managementKey !== "";
  const keyLabel =
    kind === "cliproxy"
      ? "Management key"
      : kind === "anthropic"
        ? "Console session key"
        : "API key";

  const reset = () => {
    setLabel("");
    setUrl("");
    setKeyDraft("");
    setKeyValid(true);
    setKind("cliproxy");
    setOrganizationId("");
  };

  const save = () => {
    if (!canSave) return;
    const id = initialSource?.id ?? sourceIdFromUrl(trimmedUrl, sources, kind);
    updateSettings({
      usageLimitSources: {
        [id]: {
          kind,
          ...(label.trim() || kind !== "cliproxy"
            ? { label: label.trim() || USAGE_SOURCE_PRESETS[kind].label }
            : {}),
          url: trimmedUrl,
          managementKey,
          ...(kind === "anthropic" && organizationId.trim()
            ? { organizationId: organizationId.trim() }
            : {}),
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
          <DialogTitle>{initialSource ? "Update usage source" : "Add a usage source"}</DialogTitle>
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
                disabled={!!initialSource}
                value={kind}
                onValueChange={(value) => {
                  if (value) {
                    setKind(value);
                    setKeyDraft("");
                    setKeyValid(true);
                    setOrganizationId("");
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
              <Label htmlFor="usage-source-key">{keyLabel}</Label>
              <SecretSourceInput
                id="usage-source-key"
                aria-label={keyLabel}
                value={keyDraft}
                sources={secretSources}
                environmentId={environmentId}
                onChange={(event) => setKeyDraft(event.target.value)}
                onSecretChange={(secret) => setKeyDraft(secret ?? "")}
                onValidityChange={setKeyValid}
              />
            </div>
            {kind === "anthropic" ? (
              <>
                <p className="text-sm text-muted-foreground">
                  Use the sessionKey cookie from platform.claude.com for API credits and monthly
                  spend. API keys cannot read this balance. Update the session here when it expires.
                </p>
                <div className="grid gap-1.5">
                  <Label htmlFor="usage-source-organization">Organization ID (optional)</Label>
                  <Input
                    id="usage-source-organization"
                    value={organizationId}
                    onChange={(event) => setOrganizationId(event.target.value)}
                    placeholder="Required only if you have several API organizations"
                  />
                </div>
              </>
            ) : null}
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
            {initialSource ? "Save source" : "Add source"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
