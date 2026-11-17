import {
  makePolytokenSurfaceHost,
  polytokenSurfaceDocument,
  POLYTOKEN_SURFACE_ALLOW,
  POLYTOKEN_SURFACE_SANDBOX,
  type PolytokenSurfaceProps,
} from "@t3tools/client-runtime/polytoken/surface-host";
import { useState } from "react";
import { useStableCallback } from "~/hooks/useStableCallback";
import { randomUUID } from "~/lib/utils";

export type PolytokenSurfaceFrameProps = PolytokenSurfaceProps;

export function PolytokenSurfaceFrame(props: PolytokenSurfaceFrameProps) {
  return <SurfaceDocument key={props.html} {...props} />;
}

function SurfaceDocument({ html, request, fullscreen = false }: PolytokenSurfaceFrameProps) {
  const [channel] = useState(randomUUID);
  const [height, setHeight] = useState(360);
  const [closed, setClosed] = useState(false);
  const performRequest = useStableCallback(request);
  const document = polytokenSurfaceDocument(html, channel);
  const attachFrame = (frame: HTMLIFrameElement) => {
    const loads = { count: 0 };
    const host = makePolytokenSurfaceHost({
      channel,
      request: performRequest,
      send: (message) => frame.contentWindow?.postMessage(message, "*"),
      resize: setHeight,
    });
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.origin !== "null") return;
      host.receive(event.data);
    };
    const load = () => {
      loads.count += 1;
      if (loads.count > 1) {
        host.dispose();
        setClosed(true);
      }
    };
    window.addEventListener("message", receive);
    frame.addEventListener("load", load);
    return () => {
      host.dispose();
      window.removeEventListener("message", receive);
      frame.removeEventListener("load", load);
    };
  };
  if (closed) return <p role="status">The plugin surface left its page and was stopped.</p>;
  return (
    <iframe
      ref={attachFrame}
      title="Polytoken plugin surface"
      sandbox={POLYTOKEN_SURFACE_SANDBOX}
      allow={POLYTOKEN_SURFACE_ALLOW}
      referrerPolicy="no-referrer"
      srcDoc={document}
      className="block w-full border-0"
      style={{ height: fullscreen ? "100%" : height }}
    />
  );
}
