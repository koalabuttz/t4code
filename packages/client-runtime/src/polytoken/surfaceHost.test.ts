import { describe, expect, it, vi } from "vite-plus/test";
import {
  makePolytokenSurfaceHost,
  polytokenSurfacePath,
  POLYTOKEN_SURFACE_LIMITS,
  type PolytokenSurfaceHttpResponseFrame,
  type PolytokenSurfaceRequest,
} from "./surfaceHost.ts";

const message = (id: number, input: object = {}) => ({
  polytoken: "document",
  type: "request",
  id,
  input: {
    path: "/backend/action?datastar=%7B%22x%22%3A1%7D",
    method: "POST",
    headers: {},
    ...input,
  },
});

describe("plugin-local paths", () => {
  it.each([
    ["/backend/action?datastar=%7B%7D", "/action?datastar=%7B%7D"],
    ["action?q=one%2Ftwo", "/action?q=one%2Ftwo"],
    ["./action?q=1", "/action?q=1"],
    ["?q=1", "/?q=1"],
    ["https://polytoken.invalid/backend/updates?q=1", "/updates?q=1"],
    ["/backend/backend/action", "/backend/action"],
    ["/backend?value=1", "/?value=1"],
  ])("normalizes %s without losing the query", (input, expected) => {
    expect(polytokenSurfacePath(input)).toBe(expected);
  });

  it.each([
    "https://other.test/x",
    "//other.test/x",
    "https://polytoken.invalid@other.test/x",
    "javascript:alert(1)",
    "/a/../b",
    "/a/%2e%2e/b",
    "/a/%252e/b",
    "/a%2fb",
    "/a%5cb",
    "/a\\b",
    "/a#hash",
    "/backend//other",
    "/a/%00",
    "/a/%zz",
    "/a\n",
    "",
  ])("rejects %s", (path) => {
    expect(() => polytokenSurfacePath(path)).toThrow();
  });
});

describe("surface HTTP host", () => {
  it("binds requests, removes credentials, validates frames, and ignores callbacks after cancellation", async () => {
    const sent: unknown[] = [];
    let emit!: (frame: PolytokenSurfaceHttpResponseFrame) => void;
    let signal!: AbortSignal;
    const started = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    const request: PolytokenSurfaceRequest = vi.fn(async (input, send, abort) => {
      expect(input).toEqual({
        path: "/action?datastar=%7B%22x%22%3A1%7D",
        method: "POST",
        headers: { "datastar-request": "true" },
        body: "hello",
      });
      emit = send;
      signal = abort;
      started.resolve();
      await finished.promise;
    });
    const host = makePolytokenSurfaceHost({
      channel: "document",
      request,
      send: (frame) => sent.push(frame),
    });
    host.receive({ ...message(1), polytoken: "old-document" });
    host.receive(
      message(1, {
        headers: { Cookie: "secret", Authorization: "secret", "Datastar-Request": "true" },
        body: "hello",
      }),
    );
    await started.promise;
    emit({
      type: "headers",
      status: 200,
      headers: { "Set-Cookie": "secret", "Content-Type": "text/event-stream" },
    });
    emit({ type: "chunk", data: "AP+A" });
    expect(sent).toEqual([
      {
        polytoken: "document",
        id: 1,
        frame: {
          type: "headers",
          status: 200,
          headers: { "content-type": "text/event-stream" },
          bodyless: false,
        },
      },
      { polytoken: "document", id: 1, frame: { type: "chunk", data: "AP+A" } },
    ]);
    host.receive({ polytoken: "document", type: "cancel", id: 1 });
    expect(signal.aborted).toBe(true);
    emit({ type: "end" });
    expect(sent).toHaveLength(2);
    host.dispose();
    finished.resolve();
  });

  it.each([
    [{ type: "chunk", data: "YQ==" }],
    [{ type: "headers", status: 302, headers: { location: "https://other.test" } }],
    [
      { type: "headers", status: 204, headers: {} },
      { type: "chunk", data: "YQ==" },
    ],
    [
      { type: "headers", status: 200, headers: {} },
      { type: "chunk", data: "bad!" },
    ],
    [
      { type: "headers", status: 200, headers: {} },
      {
        type: "chunk",
        data: "A".repeat(4 * Math.ceil(POLYTOKEN_SURFACE_LIMITS.chunkBytes / 3) + 4),
      },
    ],
  ] satisfies PolytokenSurfaceHttpResponseFrame[][])(
    "aborts malformed response sequence %j",
    async (...frames) => {
      const result = Promise.withResolvers<AbortSignal>();
      const send = vi.fn();
      const host = makePolytokenSurfaceHost({
        channel: "document",
        send,
        request: async (_input, emit, signal) => {
          for (const frame of frames) emit(frame);
          result.resolve(signal);
        },
      });
      host.receive(message(1));
      expect((await result.promise).aborted).toBe(true);
      expect(send).toHaveBeenLastCalledWith({
        polytoken: "document",
        id: 1,
        frame: { type: "error", message: "Surface request failed." },
      });
      host.dispose();
    },
  );

  it("bounds pending requests, rejects invalid input, and aborts every active stream on disposal", async () => {
    const signals: AbortSignal[] = [];
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const send = vi.fn();
    const host = makePolytokenSurfaceHost({
      channel: "document",
      send,
      request: async (_input, _emit, signal) => {
        signals.push(signal);
        if (signals.length === POLYTOKEN_SURFACE_LIMITS.pending) started.resolve();
        await finish.promise;
      },
    });
    for (const input of [
      { path: "//evil.test" },
      { method: "CONNECT" },
      { method: "GET", body: "body" },
      { body: "x".repeat(POLYTOKEN_SURFACE_LIMITS.requestBytes + 1) },
      { headers: { invalid: "value\n" } },
    ])
      host.receive(message(100, input));
    for (let id = 1; id <= POLYTOKEN_SURFACE_LIMITS.pending + 1; id++) host.receive(message(id));
    await started.promise;
    expect(signals).toHaveLength(POLYTOKEN_SURFACE_LIMITS.pending);
    expect(send).toHaveBeenLastCalledWith({
      polytoken: "document",
      id: 17,
      frame: { type: "error", message: "Too many surface requests." },
    });
    host.dispose();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    finish.resolve();
  });

  it.each(["chunks", "bytes"])(
    "bounds queued response %s and releases credit only for received chunks",
    async (bound) => {
      const opened = Promise.withResolvers<{
        emit: (frame: PolytokenSurfaceHttpResponseFrame) => void;
        signal: AbortSignal;
      }>();
      const finish = Promise.withResolvers<void>();
      const send = vi.fn();
      const host = makePolytokenSurfaceHost({
        channel: "document",
        send,
        request: async (_input, emit, signal) => {
          emit({ type: "headers", status: 200, headers: {} });
          opened.resolve({ emit, signal });
          await finish.promise;
        },
      });
      host.receive(message(1));
      const { emit, signal } = await opened.promise;
      for (let i = 0; i < POLYTOKEN_SURFACE_LIMITS.inFlightChunks * 2; i++) {
        emit({ type: "chunk", data: "YQ==" });
        host.receive({ polytoken: "document", type: "ack", id: 1 });
      }
      expect(signal.aborted).toBe(false);
      const count =
        bound === "chunks"
          ? POLYTOKEN_SURFACE_LIMITS.inFlightChunks
          : POLYTOKEN_SURFACE_LIMITS.bufferedBytes / POLYTOKEN_SURFACE_LIMITS.chunkBytes;
      const data = bound === "chunks" ? "" : btoa("\0".repeat(POLYTOKEN_SURFACE_LIMITS.chunkBytes));
      for (let i = 0; i < count; i++) emit({ type: "chunk", data });
      expect(signal.aborted).toBe(false);
      emit({ type: "chunk", data });
      expect(signal.aborted).toBe(true);
      expect(send).toHaveBeenLastCalledWith({
        polytoken: "document",
        id: 1,
        frame: { type: "error", message: "Surface request failed." },
      });
      finish.resolve();
      host.dispose();
    },
  );
});
