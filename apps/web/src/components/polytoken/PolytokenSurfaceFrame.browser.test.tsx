import {
  makePolytokenSurfaceHost,
  polytokenSurfaceMobileDocument,
  type PolytokenSurfaceHttpResponseFrame,
  type PolytokenSurfaceRequest,
} from "@t3tools/client-runtime/polytoken/surface-host";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { PolytokenSurfaceFrame } from "./PolytokenSurfaceFrame";

const base64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function reports() {
  const messages: MessageEvent[] = [];
  const receive = (event: MessageEvent) => {
    messages.push(event);
  };
  window.addEventListener("message", receive);
  return { messages, [Symbol.dispose]: () => window.removeEventListener("message", receive) };
}

const DATAPAGE = `<body><div data-signals="{value: 'idle'}"><button style="position:fixed;inset:0;width:100%;height:100%" data-on:click="@get('/backend/updates')">Update <span id="value" data-text="$value"></span></button></div><script>
document.addEventListener('datastar-ready',()=>parent.postMessage({test:'ready'},'*'));
new MutationObserver(()=>parent.postMessage({test:'text',text:document.getElementById('value')?.textContent},'*')).observe(document.body,{subtree:true,childList:true,characterData:true});
</script></body>`;

describe("PolytokenSurfaceFrame", () => {
  it.each([
    { contentType: "application/json", status: 200, body: '{"value":"json"}', expected: "json" },
    {
      contentType: "text/html",
      status: 200,
      body: '<span id="value">html</span>',
      expected: "html",
    },
    { contentType: "", status: 204, body: "", expected: "idle" },
  ])(
    "handles a Datastar POST returning $status $contentType",
    async ({ contentType, status, body, expected }) => {
      using report = reports();
      const request: PolytokenSurfaceRequest = vi.fn(async (input, emit) => {
        expect(input.path).toBe("/action");
        expect(input.method).toBe("POST");
        expect(JSON.parse(input.body!)).toEqual({ value: "idle" });
        emit({
          type: "headers",
          status,
          headers: contentType ? { "content-type": contentType } : {},
        });
        if (body) emit({ type: "chunk", data: base64(body) });
        emit({ type: "end" });
      });
      const html = DATAPAGE.replace("@get('/backend/updates')", "@post('/backend/action')").replace(
        "</script>",
        "document.addEventListener('datastar-fetch',event=>{if(event.detail.type==='finished')parent.postMessage({test:'finished',text:document.getElementById('value').textContent},'*')});</script>",
      );
      await using screen = await render(<PolytokenSurfaceFrame html={html} request={request} />);
      await vi.waitFor(() =>
        expect(report.messages.some((event) => event.data?.test === "ready")).toBe(true),
      );
      await userEvent.click(screen.getByTitle("Polytoken plugin surface"));
      await vi.waitFor(() =>
        expect(
          report.messages.some(
            (event) => event.data?.test === "finished" && event.data.text === expected,
          ),
        ).toBe(true),
      );
    },
  );

  it("runs bundled Datastar on a real click and applies split SSE signals and element patches", async () => {
    using report = reports();
    const opened = deferred();
    const done = deferred();
    let emit!: (frame: PolytokenSurfaceHttpResponseFrame) => void;
    const request: PolytokenSurfaceRequest = vi.fn(async (input, send) => {
      expect(input.method).toBe("GET");
      expect(input.path).toMatch(/^\/updates\?datastar=/);
      expect(input.headers["datastar-request"]).toBe("true");
      emit = send;
      send({ type: "headers", status: 200, headers: { "content-type": "text/event-stream" } });
      opened.resolve();
      await done.promise;
    });
    await using screen = await render(<PolytokenSurfaceFrame html={DATAPAGE} request={request} />);
    await vi.waitFor(() =>
      expect(report.messages.some((event) => event.data?.test === "ready")).toBe(true),
    );
    await userEvent.click(screen.getByTitle("Polytoken plugin surface"));
    await opened.promise;
    emit({ type: "chunk", data: base64('event: datastar-patch-signals\ndata: signals {"value":') });
    emit({ type: "chunk", data: base64('"streamed ☃"}\n\n') });
    await vi.waitFor(() =>
      expect(report.messages.some((event) => event.data?.text === "streamed ☃")).toBe(true),
    );
    emit({
      type: "chunk",
      data: base64(
        'event: datastar-patch-elements\ndata: elements <span id="value">patched</span>\n\n',
      ),
    });
    emit({ type: "end" });
    done.resolve();
    await vi.waitFor(() =>
      expect(report.messages.some((event) => event.data?.text === "patched")).toBe(true),
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("bridges binary responses, 204, errors and reader cancellation, rejects external fetch and forged sources", async () => {
    using report = reports();
    const cancelled = deferred();
    const done = deferred();
    const request: PolytokenSurfaceRequest = vi.fn(async (input, emit, signal) => {
      if (input.path === "/stream") {
        emit({ type: "headers", status: 200, headers: {} });
        emit({ type: "chunk", data: "AP+A" });
        signal.addEventListener(
          "abort",
          () => {
            cancelled.resolve();
            done.resolve();
          },
          { once: true },
        );
        await done.promise;
      } else if (input.path === "/empty") {
        emit({ type: "headers", status: 204, headers: {} });
        emit({ type: "end" });
      } else throw new Error("private backend failure");
    });
    const html = `<script>(async()=>{
      try{await fetch('https://evil.test/private')}catch{parent.postMessage({test:'external-blocked'},'*')}
      const response=await fetch('/backend/stream'),reader=response.body.getReader(),first=await reader.read();
      parent.postMessage({test:'binary',bytes:Array.from(first.value)},'*');await reader.cancel();
      const empty=await fetch('empty');parent.postMessage({test:'empty',status:empty.status,text:await empty.text()},'*');
      try{await fetch('/error')}catch(error){parent.postMessage({test:'error',message:error.message},'*')}
    })();</script>`;
    await using screen = await render(<PolytokenSurfaceFrame html={html} request={request} />);
    await cancelled.promise;
    await vi.waitFor(() =>
      expect(report.messages.some((event) => event.data?.test === "error")).toBe(true),
    );
    expect(report.messages.find((event) => event.data?.test === "binary")?.data.bytes).toEqual([
      0, 255, 128,
    ]);
    expect(report.messages.find((event) => event.data?.test === "empty")?.data).toMatchObject({
      status: 204,
      text: "",
    });
    expect(report.messages.find((event) => event.data?.test === "error")?.data.message).toBe(
      "Surface request failed.",
    );
    expect(report.messages.some((event) => event.data?.test === "external-blocked")).toBe(true);
    const envelope = report.messages.find((event) => event.data?.type === "request")!.data;
    window.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        origin: "null",
        data: { ...envelope, id: 999, input: { path: "/forged", method: "GET", headers: {} } },
      }),
    );
    expect(request).toHaveBeenCalledTimes(3);
    expect(screen.container.querySelector("iframe")?.sandbox.contains("allow-same-origin")).toBe(
      false,
    );
  });

  it("aborts on AbortSignal and replacement and prevents stale responses reaching the new document", async () => {
    using report = reports();
    const started = deferred();
    const cancelled = deferred();
    const replaced = deferred();
    const finish = deferred();
    let oldEmit!: (frame: PolytokenSurfaceHttpResponseFrame) => void;
    const request: PolytokenSurfaceRequest = async (input, emit, signal) => {
      if (input.path === "/abort") {
        signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
        emit({ type: "headers", status: 200, headers: {} });
      } else {
        oldEmit = emit;
        signal.addEventListener("abort", () => replaced.resolve(), { once: true });
        started.resolve();
      }
      await finish.promise;
    };
    const html = `<script>(async()=>{const controller=new AbortController();const response=await fetch('/abort',{signal:controller.signal});controller.abort();try{await response.text()}catch{parent.postMessage({test:'aborted'},'*')}void fetch('/old').then(()=>parent.postMessage({test:'stale'},'*'),()=>{});})();</script>`;
    await using screen = await render(<PolytokenSurfaceFrame html={html} request={request} />);
    await cancelled.promise;
    await started.promise;
    await screen.rerender(<PolytokenSurfaceFrame html="<p>replacement</p>" request={request} />);
    await replaced.promise;
    const count = report.messages.length;
    oldEmit({ type: "headers", status: 200, headers: {} });
    oldEmit({ type: "end" });
    finish.resolve();
    expect(report.messages.slice(count).some((event) => event.data?.test === "stale")).toBe(false);
  });

  it("stops a navigated document and cancels its active backend stream", async () => {
    const started = deferred();
    const stopped = deferred();
    const request: PolytokenSurfaceRequest = async (_input, emit, signal) => {
      signal.addEventListener("abort", () => stopped.resolve(), { once: true });
      emit({ type: "headers", status: 200, headers: {} });
      started.resolve();
      await stopped.promise;
    };
    const html = `<script>void fetch('/active');addEventListener('message',event=>{if(event.data==='navigate')location.replace('about:blank')});</script>`;
    await using screen = await render(<PolytokenSurfaceFrame html={html} request={request} />);
    await started.promise;
    screen.container.querySelector("iframe")!.contentWindow!.postMessage("navigate", "*");
    await stopped.promise;
    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent("The plugin surface left its page and was stopped.");
  });

  it("relays an opaque nested mobile frame and authenticates native replies without exposing the relay secret", async () => {
    using report = reports();
    const html = `<script>try{void parent.__t3PolytokenReceive}catch{parent.postMessage({test:'isolated'},'*')}fetch('/backend/mobile').then(response=>response.text()).then(text=>parent.postMessage({test:'mobile',text},'*'));</script>`;
    const doc = `<script>window.ReactNativeWebView={postMessage:message=>parent.postMessage(JSON.parse(message),'*')};</script>${polytokenSurfaceMobileDocument(html, "mobile-channel", "native-secret")}`;
    await using screen = await render(
      // oxlint-disable-next-line react/iframe-missing-sandbox -- trusted WebView fixture needs same-origin access for native injection; its child stays opaque
      <iframe title="Mobile relay" sandbox="allow-scripts allow-same-origin" srcDoc={doc} />,
    );
    const outer = screen.container.querySelector("iframe")!;
    const host = makePolytokenSurfaceHost({
      channel: "mobile-channel",
      send: (message) => {
        (
          outer.contentWindow as Window & { __t3PolytokenReceive: (value: unknown) => void }
        ).__t3PolytokenReceive(message);
      },
      request: async (input, emit) => {
        expect(input.path).toBe("/mobile");
        emit({ type: "headers", status: 200, headers: {} });
        emit({ type: "chunk", data: base64("relayed") });
        emit({ type: "end" });
      },
    });
    const relay = (event: MessageEvent) => {
      if (event.source === outer.contentWindow && event.data?.secret === "native-secret")
        host.receive(event.data.message);
    };
    window.addEventListener("message", relay);
    using _cleanup = {
      [Symbol.dispose]() {
        window.removeEventListener("message", relay);
        host.dispose();
      },
    };
    await vi.waitFor(() =>
      expect(report.messages.some((event) => event.data?.message?.test === "mobile")).toBe(true),
    );
    expect(
      report.messages.find((event) => event.data?.message?.test === "mobile")?.data.message.text,
    ).toBe("relayed");
    expect(report.messages.some((event) => event.data?.message?.test === "isolated")).toBe(true);
  });
});
