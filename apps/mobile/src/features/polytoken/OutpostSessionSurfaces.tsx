import { useAtomValue } from "@effect/atom-react";
import type { PolytokenSurfaceRequest } from "@t3tools/client-runtime/polytoken/surface-host";
import { parseOutpostSurfaceRequest } from "@t3tools/client-runtime/state/polytoken-surfaces";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, OutpostSurface } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Modal, View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { useEnvironments } from "../../state/environments";
import { outpostSurfaceEnvironment } from "../../state/polytoken";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { PolytokenSurfaceWebView } from "./PolytokenSurfaceWebView";

interface Props {
  readonly environmentId: EnvironmentId;
  readonly connectionId: string;
  readonly sessionId: string;
}

export function OutpostSessionSurfaces(props: Props) {
  const { environments } = useEnvironments();
  const [open, setOpen] = useState(false);
  const environment = environments.find(
    (environment) => environment.environmentId === props.environmentId,
  );
  if (!environment?.serverConfig?.environment.capabilities.outpostSurfaces) return null;
  return (
    <View className="gap-2">
      <Button
        size="compact"
        label={open ? "Close plugin surfaces" : "Plugin surfaces"}
        onPress={() => setOpen(!open)}
      />
      {open ? <SurfaceList {...props} /> : null}
    </View>
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
    <View className="gap-2">
      {state.error || error ? (
        <AppText accessibilityRole="alert">{state.error ?? error}</AppText>
      ) : null}
      {state.isPending && !state.data ? <AppText>Loading plugin surfaces…</AppText> : null}
      {state.data?.status === "reconnecting" ? (
        <AppText>Reconnecting plugin surfaces…</AppText>
      ) : null}
      {state.data?.surfaces.length === 0 ? (
        <AppText>No plugin surfaces are published.</AppText>
      ) : null}
      {!allowed ? <AppText>Operating access is required to open plugin surfaces.</AppText> : null}
      {state.data?.surfaces.map((surface) => (
        <Button
          key={`${surface.pluginName}:${surface.surfaceId}`}
          size="compact"
          label={`${surface.pluginName} · ${surface.surfaceId}`}
          disabled={!allowed || busy}
          onPress={() => void open(surface)}
        />
      ))}
      {document && !current ? (
        <AppText>
          This surface changed or is unavailable. Open its current version to reconnect.
        </AppText>
      ) : null}
      {current ? (
        <>
          <Button size="compact" label="Fullscreen" onPress={() => setFullscreen(true)} />
          <Button size="compact" label="Close surface" onPress={() => setDocument(null)} />
          {!fullscreen ? (
            <PolytokenSurfaceWebView
              key={`${connectionId}:${sessionId}:${current.surface.pluginName}:${current.surface.surfaceId}:${current.epoch}:${current.surface.generation}:${current.surface.revision}`}
              html={current.html}
              request={request}
            />
          ) : null}
          <Modal
            visible={fullscreen}
            presentationStyle="fullScreen"
            onRequestClose={() => setFullscreen(false)}
          >
            <View className="flex-1 bg-screen p-4">
              <Button label="Close fullscreen" onPress={() => setFullscreen(false)} />
              {fullscreen ? (
                <PolytokenSurfaceWebView
                  key={`${connectionId}:${sessionId}:${current.surface.pluginName}:${current.surface.surfaceId}:${current.epoch}:${current.surface.generation}:${current.surface.revision}`}
                  html={current.html}
                  request={request}
                  fullscreen
                />
              ) : null}
            </View>
          </Modal>
        </>
      ) : null}
    </View>
  );
}
