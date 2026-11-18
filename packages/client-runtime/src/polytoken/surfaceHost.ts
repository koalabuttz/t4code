import { datastarRuntime } from "./datastar-v1.0.4.ts";

export interface PolytokenSurfaceHttpRequest {
  readonly path: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export type PolytokenSurfaceHttpResponseFrame =
  | {
      readonly type: "headers";
      readonly status: number;
      readonly headers: Readonly<Record<string, string>>;
    }
  | { readonly type: "chunk"; readonly data: string }
  | { readonly type: "end" };

export type PolytokenSurfaceRequest = (
  input: PolytokenSurfaceHttpRequest,
  emit: (frame: PolytokenSurfaceHttpResponseFrame) => void,
  signal: AbortSignal,
) => Promise<void>;

export interface PolytokenSurfaceProps {
  readonly html: string;
  readonly request: PolytokenSurfaceRequest;
  readonly fullscreen?: boolean;
}

export const POLYTOKEN_SURFACE_LIMITS = {
  htmlBytes: 1024 * 1024,
  requestBytes: 256 * 1024,
  chunkBytes: 64 * 1024,
  bufferedBytes: 1024 * 1024,
  inFlightChunks: 64,
  chunks: 65536,
  pending: 16,
  pathLength: 4096,
  headerBytes: 16384,
  headers: 16,
} as const;

export const POLYTOKEN_SURFACE_SANDBOX = "allow-scripts allow-forms";
export const POLYTOKEN_SURFACE_ALLOW =
  "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'";

// A synthetic base lets Datastar resolve relative URLs without exposing an environment origin.
export function polytokenSurfacePath(input: string, stripBackend = true): string {
  let path = input.startsWith("https://polytoken.invalid/")
    ? input.slice("https://polytoken.invalid".length)
    : input;
  if (
    !path ||
    path.length > 4096 ||
    /[\\\s\u0000-\u001f\u007f#]/.test(path) ||
    path.startsWith("//") ||
    /^[a-z][a-z\d+.-]*:/i.test(path)
  ) {
    throw new Error("Only plugin-local paths are supported.");
  }
  if (path.startsWith("?")) path = `/${path}`;
  const [pathname] = path.split("?", 1);
  if (!pathname || /%(?:2f|5c|25)/i.test(pathname)) throw new Error("Invalid plugin path.");
  const decoded = decodeURIComponent(pathname);
  if (/[\\\u0000-\u0020\u007f]/.test(decoded) || decoded.split("/").some((part) => part === "..")) {
    throw new Error("Invalid plugin path.");
  }
  path =
    pathname
      .split("/")
      .filter((part) => part !== ".")
      .join("/") + path.slice(pathname.length);
  if (!path.startsWith("/")) path = `/${path}`;
  if (
    stripBackend &&
    (path === "/backend" || path.startsWith("/backend?") || path.startsWith("/backend/"))
  ) {
    path = path.slice("/backend".length);
    if (!path || path.startsWith("?")) path = `/${path}`;
  }
  if (path.startsWith("//")) throw new Error("Invalid plugin path.");
  return path;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeHeaders(value: unknown): Readonly<Record<string, string>> {
  if (!record(value) || Object.keys(value).length > POLYTOKEN_SURFACE_LIMITS.headers)
    throw new Error("Invalid headers.");
  const result: Record<string, string> = {};
  let bytes = 0;
  for (const [key, entry] of Object.entries(value)) {
    if (
      !/^[!#$%&'*+.^_`|~\w-]+$/.test(key) ||
      typeof entry !== "string" ||
      /[\r\n\u0000]/.test(entry)
    )
      throw new Error("Invalid headers.");
    bytes += key.length + entry.length;
    if (bytes > POLYTOKEN_SURFACE_LIMITS.headerBytes) throw new Error("Headers too large.");
    if (
      /^(authorization|proxy-authorization|cookie|set-cookie|host|origin|referer|connection|content-length|transfer-encoding|upgrade|proxy-connection|keep-alive|te|trailer)$/i.test(
        key,
      )
    )
      continue;
    result[key.toLowerCase()] = entry;
  }
  return result;
}

export function makePolytokenSurfaceHost(options: {
  readonly channel: string;
  readonly request: PolytokenSurfaceRequest;
  readonly send: (message: unknown) => void;
  readonly resize?: (height: number) => void;
}) {
  const pending = new Map<
    number,
    {
      controller: AbortController;
      headers: boolean;
      chunks: number;
      bodyless: boolean;
      queued: number[];
      queuedBytes: number;
    }
  >();
  let disposed = false;
  const send = (id: number, frame: unknown) =>
    options.send({ polytoken: options.channel, id, frame });
  const stop = (id: number) => {
    const entry = pending.get(id);
    pending.delete(id);
    entry?.controller.abort();
  };
  const fail = (id: number) => {
    if (disposed || !pending.has(id)) return;
    send(id, { type: "error", message: "Surface request failed." });
    stop(id);
  };
  const dispose = () => {
    disposed = true;
    for (const id of pending.keys()) stop(id);
  };
  return {
    dispose,
    receive(message: unknown) {
      if (disposed || !record(message) || message.polytoken !== options.channel) return;
      if (message.type === "close") {
        dispose();
        return;
      }
      if (message.type === "resize") {
        if (typeof message.height === "number" && Number.isFinite(message.height))
          options.resize?.(Math.max(120, Math.min(1200, Math.ceil(message.height))));
        return;
      }
      const id = message.id;
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) return;
      if (message.type === "cancel") {
        stop(id);
        return;
      }
      if (message.type === "ack") {
        const entry = pending.get(id);
        if (entry) entry.queuedBytes -= entry.queued.shift() ?? 0;
        return;
      }
      if (message.type !== "request") return;
      // Duplicated IDs must never replace an in-flight request or its cancellation handle.
      if (pending.has(id)) {
        fail(id);
        return;
      }
      if (pending.size >= POLYTOKEN_SURFACE_LIMITS.pending) {
        send(id, { type: "error", message: "Too many surface requests." });
        return;
      }
      let input: PolytokenSurfaceHttpRequest;
      try {
        const raw = message.input;
        if (!record(raw) || typeof raw.path !== "string" || typeof raw.method !== "string")
          throw new Error("Invalid request.");
        const method = raw.method.toUpperCase();
        if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|QUERY)$/.test(method))
          throw new Error("Invalid method.");
        if (
          raw.body !== undefined &&
          (typeof raw.body !== "string" ||
            raw.body.length > POLYTOKEN_SURFACE_LIMITS.requestBytes ||
            new TextEncoder().encode(raw.body).length > POLYTOKEN_SURFACE_LIMITS.requestBytes ||
            method === "GET" ||
            method === "HEAD")
        )
          throw new Error("Invalid body.");
        input = {
          path: polytokenSurfacePath(raw.path),
          method,
          headers: safeHeaders(raw.headers),
          ...(typeof raw.body === "string" ? { body: raw.body } : {}),
        };
      } catch {
        send(id, { type: "error", message: "Invalid surface request." });
        return;
      }
      const entry = {
        controller: new AbortController(),
        headers: false,
        chunks: 0,
        bodyless: input.method === "HEAD",
        queued: [] as number[],
        queuedBytes: 0,
      };
      pending.set(id, entry);
      const emit = (frame: PolytokenSurfaceHttpResponseFrame) => {
        if (disposed || pending.get(id) !== entry) return;
        try {
          if (frame.type === "headers") {
            if (
              entry.headers ||
              !Number.isInteger(frame.status) ||
              frame.status < 200 ||
              frame.status > 599 ||
              (frame.status >= 300 && frame.status < 400 && frame.status !== 304)
            )
              throw new Error("Invalid status.");
            entry.headers = true;
            entry.bodyless ||= frame.status === 204 || frame.status === 205 || frame.status === 304;
            send(id, { ...frame, headers: safeHeaders(frame.headers), bodyless: entry.bodyless });
          } else if (frame.type === "chunk") {
            if (
              !entry.headers ||
              entry.bodyless ||
              typeof frame.data !== "string" ||
              frame.data.length > Math.ceil(POLYTOKEN_SURFACE_LIMITS.chunkBytes / 3) * 4 ||
              !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
                frame.data,
              ) ||
              (frame.data.length / 4) * 3 -
                (frame.data.endsWith("==") ? 2 : frame.data.endsWith("=") ? 1 : 0) >
                POLYTOKEN_SURFACE_LIMITS.chunkBytes ||
              ++entry.chunks > POLYTOKEN_SURFACE_LIMITS.chunks
            )
              throw new Error("Invalid chunk.");
            const bytes =
              (frame.data.length / 4) * 3 -
              (frame.data.endsWith("==") ? 2 : frame.data.endsWith("=") ? 1 : 0);
            entry.queuedBytes += bytes;
            if (
              entry.queuedBytes > POLYTOKEN_SURFACE_LIMITS.bufferedBytes ||
              entry.queued.length >= POLYTOKEN_SURFACE_LIMITS.inFlightChunks
            )
              throw new Error("Surface response queue exceeded.");
            entry.queued.push(bytes);
            send(id, frame);
          } else if (frame.type === "end") {
            if (!entry.headers) throw new Error("Missing headers.");
            pending.delete(id);
            send(id, frame);
          } else throw new Error("Invalid frame.");
        } catch {
          fail(id);
        }
      };
      void Promise.resolve()
        .then(() => {
          if (!entry.controller.signal.aborted)
            return options.request(input, emit, entry.controller.signal);
        })
        .then(
          () => {
            if (pending.get(id) === entry) fail(id);
          },
          () => {
            if (pending.get(id) === entry) fail(id);
          },
        );
    },
  };
}

// Serialized into the opaque frame: keep all runtime dependencies in the parameters or function body.
function surfaceBootstrap(
  channel: string,
  limits: typeof POLYTOKEN_SURFACE_LIMITS,
  pathFor: typeof polytokenSurfacePath,
) {
  const send = (message: object) => parent.postMessage({ ...message, polytoken: channel }, "*");
  type Pending = {
    resolve: (response: Response) => void;
    reject: (reason: unknown) => void;
    stream: ReadableStreamDefaultController<Uint8Array>;
    body: ReadableStream<Uint8Array>;
    cleanup: () => void;
    headers: boolean;
  };
  const pending = new Map<number, Pending>();
  let sequence = 0;
  let live = true;
  const fail = (id: number, reason: unknown) => {
    const item = pending.get(id);
    if (!item) return;
    pending.delete(id);
    item.cleanup();
    item.reject(reason);
    item.stream.error(reason);
    send({ type: "cancel", id });
  };
  window.fetch = async (resource, init) => {
    if (!live || pending.size >= limits.pending)
      throw new TypeError("Surface request unavailable.");
    const raw = resource instanceof Request ? resource.url : String(resource);
    const path = pathFor(raw, false);
    const request =
      resource instanceof Request
        ? new Request(resource, init)
        : new Request(`https://polytoken.invalid${path}`, init);
    if (request.signal.aborted) throw request.signal.reason;
    const id = ++sequence;
    const headers = Object.fromEntries(request.headers);
    const abort = () =>
      fail(id, request.signal.reason ?? new DOMException("Aborted", "AbortError"));
    let requestReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          stream = controller;
        },
        cancel() {
          const item = pending.get(id);
          pending.delete(id);
          item?.cleanup();
          send({ type: "cancel", id });
        },
      },
      { highWaterMark: limits.bufferedBytes, size: (chunk) => chunk.byteLength },
    );
    const response = new Promise<Response>((resolve, reject) => {
      pending.set(id, {
        resolve,
        reject,
        stream,
        body,
        headers: false,
        cleanup: () => {
          request.signal.removeEventListener("abort", abort);
          void requestReader?.cancel().catch(() => {});
        },
      });
    });
    request.signal.addEventListener("abort", abort, { once: true });
    void (async () => {
      let text: string | undefined;
      if (request.body) {
        const reader = (requestReader = request.body.getReader());
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > limits.requestBytes || chunks.length >= limits.chunks || !pending.has(id)) {
            await reader.cancel();
            throw new TypeError("Surface body too large or cancelled.");
          }
          chunks.push(next.value);
        }
        requestReader = undefined;
        reader.releaseLock();
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      }
      if (pending.has(id))
        send({
          type: "request",
          id,
          input: {
            path,
            method: request.method,
            headers,
            ...(text !== undefined ? { body: text } : {}),
          },
        });
    })().catch((error: unknown) => fail(id, error));
    return response;
  };
  window.addEventListener("message", (event) => {
    const message = event.data;
    if (event.source !== parent || !live || message?.polytoken !== channel) return;
    const item = pending.get(message.id);
    if (!item) return;
    const frame = message.frame;
    try {
      if (frame?.type === "headers" && !item.headers) {
        item.headers = true;
        item.resolve(
          new Response(frame.bodyless ? null : item.body, {
            status: frame.status,
            headers: frame.headers,
          }),
        );
      } else if (frame?.type === "chunk" && item.headers) {
        const binary = atob(frame.data);
        if (binary.length > limits.chunkBytes || binary.length > (item.stream.desiredSize ?? 0))
          throw new TypeError("Surface response buffer exceeded.");
        item.stream.enqueue(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
        send({ type: "ack", id: message.id });
      } else if (frame?.type === "end" && item.headers) {
        pending.delete(message.id);
        item.cleanup();
        item.stream.close();
      } else throw new TypeError("Surface request failed.");
    } catch (error) {
      fail(message.id, error);
    }
  });
  window.addEventListener("pagehide", () => {
    live = false;
    for (const id of pending.keys()) fail(id, new TypeError("Surface closed."));
    send({ type: "close" });
  });
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      if (target instanceof Element && target.closest("a[href],area[href]")) event.preventDefault();
    },
    true,
  );
  document.addEventListener("submit", (event) => event.preventDefault(), true);
  document.addEventListener(
    "DOMContentLoaded",
    () => {
      let height = 0;
      const resize = () => {
        const next = Math.ceil(
          Math.max(
            document.body?.scrollHeight ?? 0,
            document.body?.getBoundingClientRect().bottom ?? 0,
          ),
        );
        if (height !== next) {
          height = next;
          send({ type: "resize", height });
        }
      };
      new ResizeObserver(resize).observe(document.documentElement);
      resize();
    },
    { once: true },
  );
}

const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

export function polytokenSurfaceDocument(html: string, channel: string): string {
  if (
    html.length > POLYTOKEN_SURFACE_LIMITS.htmlBytes ||
    new TextEncoder().encode(html).length > POLYTOKEN_SURFACE_LIMITS.htmlBytes
  )
    throw new Error("Surface HTML too large.");
  const csp =
    "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri https://polytoken.invalid; form-action 'none'";
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1"><base href="https://polytoken.invalid/"><script>(${surfaceBootstrap.toString()})(${scriptJson(channel)},${scriptJson(POLYTOKEN_SURFACE_LIMITS)},${polytokenSurfacePath.toString()});</script><script type="module">${datastarRuntime.replace(/<\/script/gi, "<\\/script")}</script></head>${html}`;
}

export function polytokenSurfaceMobileDocument(
  html: string,
  channel: string,
  secret: string,
): string {
  const inner = polytokenSurfaceDocument(html, channel);
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; base-uri https://polytoken.invalid; frame-src about:;"><style>html,body{margin:0;height:100%;background:transparent}iframe{border:0;display:block;width:100%;height:100%}</style></head><body><iframe id="surface" sandbox="${POLYTOKEN_SURFACE_SANDBOX}" allow="${POLYTOKEN_SURFACE_ALLOW}"></iframe><script>(()=>{const frame=document.getElementById('surface'),secret=${scriptJson(secret)};let loads=0,live=true;const send=message=>window.ReactNativeWebView.postMessage(JSON.stringify({secret,message}));window.addEventListener('message',event=>{if(live&&event.source===frame.contentWindow)send(event.data)});frame.addEventListener('load',()=>{if(++loads>1){live=false;send({polytoken:${scriptJson(channel)},type:'close'})}});window.__t3PolytokenReceive=message=>{if(live)frame.contentWindow.postMessage(message,'*')};frame.srcdoc=${scriptJson(inner)};})();</script></body></html>`;
}
