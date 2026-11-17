import * as Schema from "effect/Schema";

import { OutpostSessionInput } from "./polytoken.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const OutpostSurface = Schema.Struct({
  pluginName: TrimmedNonEmptyString,
  surfaceId: TrimmedNonEmptyString,
  generation: TrimmedNonEmptyString,
  revision: TrimmedNonEmptyString,
  sourcePath: TrimmedNonEmptyString,
});
export type OutpostSurface = typeof OutpostSurface.Type;

export const OutpostSurfaceState = Schema.Struct({
  epoch: Schema.NullOr(TrimmedNonEmptyString),
  status: Schema.Literals(["live", "reconnecting"]),
  surfaces: Schema.Array(OutpostSurface).check(Schema.isMaxLength(256)),
});
export type OutpostSurfaceState = typeof OutpostSurfaceState.Type;

export const OutpostSurfaceInput = Schema.Struct({
  ...OutpostSessionInput.fields,
  pluginName: TrimmedNonEmptyString,
  surfaceId: TrimmedNonEmptyString,
  generation: TrimmedNonEmptyString,
});
export type OutpostSurfaceInput = typeof OutpostSurfaceInput.Type;

export const OutpostSurfaceDocument = Schema.Struct({
  surface: OutpostSurface,
  html: Schema.String.check(Schema.isMaxLength(1024 * 1024)),
});

export const OutpostSurfaceRequestInput = Schema.Struct({
  ...OutpostSurfaceInput.fields,
  path: Schema.String.check(Schema.isMaxLength(4096)),
  method: Schema.Literals(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "QUERY"]),
  headers: Schema.Record(Schema.String, Schema.String).check(Schema.isMaxProperties(16)),
  body: Schema.optional(Schema.String.check(Schema.isMaxLength(256 * 1024))),
});
export type OutpostSurfaceRequestInput = typeof OutpostSurfaceRequestInput.Type;

export const OutpostSurfaceResponseFrame = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("headers"),
    status: Schema.Number,
    headers: Schema.Record(Schema.String, Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("chunk"),
    data: Schema.String.check(Schema.isMaxLength(96 * 1024)),
  }),
  Schema.Struct({ type: Schema.Literal("end") }),
]);
export type OutpostSurfaceResponseFrame = typeof OutpostSurfaceResponseFrame.Type;
