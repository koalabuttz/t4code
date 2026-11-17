import { useAtomValue } from "@effect/atom-react";
import { parseOutpostSurfaceRequest } from "@t3tools/client-runtime/state/polytoken-surfaces";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { PolytokenSurfaceRequest } from "@t3tools/client-runtime/polytoken/surface-host";
import type { EnvironmentId, OutpostSurface } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { useEnvironment } from "../../state/environments";
import { outpostSurfaceEnvironment } from "../../state/polytoken";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogBackdrop,
  DialogPortal,
  DialogPopup,
  DialogTitle,
  DialogViewport,
} from "../ui/dialog";
import { PolytokenSurfaceFrame } from "./PolytokenSurfaceFrame";

interface Props {
  readonly environmentId: EnvironmentId;
  readonly connectionId: string;
  readonly sessionId: string;
}

export function OutpostSessionSurfaces(props: Props) {
  const environment = useEnvironment(props.environmentId);
  const [open, setOpen] = useState(false);
  if (!environment?.serverConfig?.environment.capabilities.outpostSurfaces) return null;
  return (
    <div className="space-y-2">
      <Button size="sm" variant="outline" onClick={() => setOpen(!open)}>
        {open ? "Close plugin surfaces" : "Plugin surfaces"}
      </Button>
      {open ? <SurfaceList {...props} /> : null}
    </div>
  );
}

function SurfaceList({ environmentId, connectionId, sessionId }: Props) {
  const input = { connectionId, sessionId };
  const state = useEnvironmentQuery(outpostSurfaceEnvironment.changes({ environmentId, input }));
  const read = useAtomCommand(outpostSurfaceEnvironment.read, { reportFailure: false });
  const performRequest = useAtomCommand(outpostSurfaceEnvironment.request, {
    reportFailure: false,
  });
  const allowed = useAtomValue(outpostSurfaceEnvironment.read.permissionAtom(environmentId));
  const [document, setDocument] = useState<{
    surface: OutpostSurface;
    html: string;
    epoch: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const current =
    document &&
    !state.error &&
    state.data?.status === "live" &&
    state.data.epoch === document.epoch &&
    state.data.surfaces.some(
      (surface) =>
        surface.pluginName === document.surface.pluginName &&
        surface.surfaceId === document.surface.surfaceId &&
        surface.generation === document.surface.generation &&
        surface.revision === document.surface.revision,
    )
      ? document
      : null;
  const request: PolytokenSurfaceRequest = async (http, emit, signal) => {
    if (!current) throw new Error("This plugin surface is no longer available.");
    const result = await performRequest({
      environmentId,
      input: parseOutpostSurfaceRequest({
        ...http,
        ...input,
        pluginName: current.surface.pluginName,
        surfaceId: current.surface.surfaceId,
        generation: current.surface.generation,
      }),
      onValue: emit,
      signal,
    });
    if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
  };
  const open = async (surface: OutpostSurface) => {
    setBusy(true);
    setError(null);
    const epoch = state.data?.epoch;
    const result = await read({
      environmentId,
      input: {
        ...input,
        pluginName: surface.pluginName,
        surfaceId: surface.surfaceId,
        generation: surface.generation,
      },
    });
    if (AsyncResult.isFailure(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not open plugin surface.");
    } else if (epoch) setDocument({ ...result.value, epoch });
    setBusy(false);
  };
  return (
    <div className="space-y-2">
      {state.error || error ? <p role="alert">{state.error ?? error}</p> : null}
      {state.isPending && !state.data ? <p>Loading plugin surfaces…</p> : null}
      {state.data?.status === "reconnecting" ? (
        <p role="status">Reconnecting plugin surfaces…</p>
      ) : null}
      {state.data?.surfaces.length === 0 ? <p>No plugin surfaces are published.</p> : null}
      {!allowed ? <p>Operating access is required to open plugin surfaces.</p> : null}
      <div className="flex flex-wrap gap-2">
        {state.data?.surfaces.map((surface) => (
          <Button
            key={`${surface.pluginName}:${surface.surfaceId}`}
            size="sm"
            variant="outline"
            disabled={!allowed || busy}
            onClick={() => void open(surface)}
          >
            {surface.pluginName} · {surface.surfaceId}
          </Button>
        ))}
      </div>
      {document && !current ? (
        <p role="status">
          This surface changed or is unavailable. Open its current version to reconnect.
        </p>
      ) : null}
      {current ? (
        <>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setFullscreen(true)}>
              Fullscreen
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDocument(null)}>
              Close surface
            </Button>
          </div>
          {!fullscreen ? (
            <PolytokenSurfaceFrame
              key={`${connectionId}:${sessionId}:${current.surface.pluginName}:${current.surface.surfaceId}:${current.epoch}:${current.surface.generation}:${current.surface.revision}`}
              html={current.html}
              request={request}
            />
          ) : null}
          <Dialog open={fullscreen} onOpenChange={setFullscreen}>
            <DialogPortal>
              <DialogBackdrop />
              <DialogViewport>
                <DialogPopup variant="media" bottomStickOnMobile={false}>
                  <DialogTitle>
                    {current.surface.pluginName} · {current.surface.surfaceId}
                  </DialogTitle>
                  <div className="h-[80vh] w-[85vw]">
                    {fullscreen ? (
                      <PolytokenSurfaceFrame
                        key={`${connectionId}:${sessionId}:${current.surface.pluginName}:${current.surface.surfaceId}:${current.epoch}:${current.surface.generation}:${current.surface.revision}`}
                        html={current.html}
                        request={request}
                        fullscreen
                      />
                    ) : null}
                  </div>
                </DialogPopup>
              </DialogViewport>
            </DialogPortal>
          </Dialog>
        </>
      ) : null}
    </div>
  );
}
