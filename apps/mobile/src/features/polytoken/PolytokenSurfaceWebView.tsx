import {
  makePolytokenSurfaceHost,
  polytokenSurfaceMobileDocument,
  POLYTOKEN_SURFACE_LIMITS,
  type PolytokenSurfaceProps,
} from "@t3tools/client-runtime/polytoken/surface-host";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Platform, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { AppText } from "../../components/ui/AppText";
import { uuidv4 } from "../../lib/uuid";

export type PolytokenSurfaceWebViewProps = PolytokenSurfaceProps;

export function PolytokenSurfaceWebView(props: PolytokenSurfaceWebViewProps) {
  return <SurfaceDocument key={props.html} {...props} />;
}

function SurfaceDocument({ html, request, fullscreen = false }: PolytokenSurfaceWebViewProps) {
  const [channel] = useState(uuidv4);
  const [secret] = useState(uuidv4);
  const [height, setHeight] = useState(360);
  const [closed, setClosed] = useState(false);
  const view = useRef<WebView<object>>(null);
  const host = useRef<ReturnType<typeof makePolytokenSurfaceHost> | null>(null);
  const performRequest = useEffectEvent(request);
  // The native view and authenticated relay own the request lifetime.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- synchronize the bridge with the native WebView lifetime
  useEffect(() => {
    const bridge = makePolytokenSurfaceHost({
      channel,
      request: (input, emit, signal) => performRequest(input, emit, signal),
      resize: setHeight,
      send: (message) =>
        view.current?.injectJavaScript(
          `window.__t3PolytokenReceive?.(${JSON.stringify(message).replace(/</g, "\\u003c")});true;`,
        ),
    });
    host.current = bridge;
    return () => {
      bridge.dispose();
      host.current = null;
    };
  }, [channel]);
  const onMessage = (event: WebViewMessageEvent) => {
    if (
      event.nativeEvent.data.length >
      6 *
        (POLYTOKEN_SURFACE_LIMITS.requestBytes +
          POLYTOKEN_SURFACE_LIMITS.headerBytes +
          POLYTOKEN_SURFACE_LIMITS.pathLength)
    )
      return;
    let envelope: unknown;
    try {
      envelope = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    if (
      typeof envelope !== "object" ||
      envelope === null ||
      !("secret" in envelope) ||
      envelope.secret !== secret ||
      !("message" in envelope)
    )
      return;
    const message = envelope.message;
    host.current?.receive(message);
    if (
      typeof message === "object" &&
      message !== null &&
      "polytoken" in message &&
      message.polytoken === channel &&
      "type" in message &&
      message.type === "close"
    )
      setClosed(true);
  };
  const source = { html: polytokenSurfaceMobileDocument(html, channel, secret) };
  return (
    <View style={fullscreen ? { flex: 1 } : { height }}>
      {closed ? (
        <AppText>The plugin surface was stopped.</AppText>
      ) : (
        <WebView<object>
          ref={view}
          source={source}
          accessibilityLabel="Polytoken plugin surface"
          style={{ flex: 1, backgroundColor: "transparent" }}
          originWhitelist={["*"]}
          // Android reports nested iframe loads as top-level; CSP and the opaque iframe confine them.
          onShouldStartLoadWithRequest={(navigation) =>
            Platform.OS === "android" ||
            navigation.isTopFrame === false ||
            navigation.url === "about:blank"
          }
          setSupportMultipleWindows={false}
          javaScriptCanOpenWindowsAutomatically={false}
          sharedCookiesEnabled={false}
          thirdPartyCookiesEnabled={false}
          allowFileAccess={false}
          allowFileAccessFromFileURLs={false}
          allowUniversalAccessFromFileURLs={false}
          mixedContentMode="never"
          onMessage={onMessage}
          onError={() => {
            host.current?.dispose();
            setClosed(true);
          }}
          onContentProcessDidTerminate={() => {
            host.current?.dispose();
            setClosed(true);
          }}
          onRenderProcessGone={() => {
            host.current?.dispose();
            setClosed(true);
          }}
        />
      )}
    </View>
  );
}
