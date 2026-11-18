import { expect, it } from "vite-plus/test";
import * as Base64 from "effect/encoding/Base64";
import { createOutpostAttachmentReader, outpostHistoryText } from "./polytoken.ts";

it("reads current public-history text captures and keeps unknown blocks visible", () => {
  expect(
    outpostHistoryText({ type: "user_message", content: { text: "Hello", truncated: false } }),
  ).toBe("User\nHello");
  expect(
    outpostHistoryText({
      type: "assistant_message",
      blocks: [
        { type: "text", text: { text: "Saved answer" } },
        { type: "future_block", value: 3 },
      ],
    }),
  ).toContain('Saved answer\n{\n  "type": "future_block"');
  expect(outpostHistoryText({ type: "future_item", payload: "kept" })).toContain(
    '"payload": "kept"',
  );
});

it("decodes chunked UTF-8 without corrupting split characters or mixing checkpoints", () => {
  const read = createOutpostAttachmentReader();
  const chunk = {
    artifact_id: "artifact",
    media_type: "text/plain",
    total_length: 4,
    offset: 0,
    data_base64: Base64.encode(new Uint8Array([0xf0, 0x9f])),
  };
  expect(read("checkpoint:A", chunk)).toMatchObject({ text: "", next: 2, total: 4 });
  expect(
    read("checkpoint:A", {
      ...chunk,
      offset: 2,
      data_base64: Base64.encode(new Uint8Array([0x98, 0x80])),
    }),
  ).toMatchObject({ text: "😀", next: 4 });
  read("checkpoint:A", chunk);
  expect(
    read("checkpoint:B", { ...chunk, total_length: 2, data_base64: Base64.encode("ok") }).text,
  ).toBe("ok");
});
