import { makeProviderSettingsSchema, TrimmedString } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const AlbedoSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    homeDirectory: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Albedo home",
        description:
          "The Albedo home directory on this environment, containing the running daemon's daemon.json. Leave empty to use ALBEDO_HOME or ~/.albedo.",
        providerSettingsForm: { placeholder: "~/.albedo", clearWhenEmpty: "omit" },
      }),
    ),
  },
  { order: ["homeDirectory"] },
);
export type AlbedoSettings = typeof AlbedoSettings.Type;
