import type { ChatAttachment } from "@t3tools/contracts";
import { ProviderHost } from "@t3tools/provider-core/server/ProviderHost";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Base64 from "effect/encoding/Base64";

import { AlbedoProjectionError } from "./turnProjection.ts";
import type * as Protocol from "./protocol.ts";

export const message = Effect.fn("AlbedoAttachments.message")(function* (
  text: string,
  attachments: ReadonlyArray<ChatAttachment>,
) {
  const host = yield* ProviderHost;
  const fs = yield* FileSystem.FileSystem;
  const images: {
    mime_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
    data: string;
  }[] = [];
  const files: { name: string; data: string }[] = [];
  let total = new TextEncoder().encode(text).byteLength;
  for (const attachment of attachments) {
    const path = host.resolveAttachmentPath(attachment);
    if (path === null || (attachment.type !== "image" && attachment.type !== "file"))
      return yield* new AlbedoProjectionError({
        detail: "This attachment cannot be read by Albedo. Attach the file again before sending.",
      });
    const info = yield* fs.stat(path);
    total += Number(info.size);
    if (total > 16 * 1024 * 1024)
      return yield* new AlbedoProjectionError({
        detail: "Albedo attachments exceed the 16 MiB input limit. Send fewer or smaller files.",
      });
    const data = Base64.encode(yield* fs.readFile(path));
    if (attachment.type === "image") {
      const mime = attachment.mimeType;
      if (
        mime !== "image/png" &&
        mime !== "image/jpeg" &&
        mime !== "image/gif" &&
        mime !== "image/webp"
      )
        return yield* new AlbedoProjectionError({
          detail:
            "Albedo supports PNG, JPEG, GIF and WebP image attachments. Convert this image before sending.",
        });
      images.push({ mime_type: mime, data });
    } else files.push({ name: attachment.name, data });
  }
  return {
    kind: "message",
    text,
    ...(images.length > 0 ? { images } : {}),
    ...(files.length > 0 ? { files } : {}),
  } satisfies typeof Protocol.InputRequest.Type;
});
