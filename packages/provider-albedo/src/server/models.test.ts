import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { AlbedoClient } from "./AlbedoClient.ts";
import { fakeDaemon, instanceId } from "./adapter.test-fixtures.ts";
import * as Models from "./models.ts";

describe("Albedo profile and model selections", () => {
  it.effect(
    "round-trips profile and model names containing slashes without changing the selection",
    () =>
      Effect.gen(function* () {
        const fake = yield* fakeDaemon;
        const profile = "team/account";
        const model = "vendor/model%1";
        const client = {
          ...fake.client,
          readProviderSettings: Effect.succeed({
            default_profile: profile,
            profiles: { [profile]: { extension: "openai", model, effort: "high", has_key: true } },
          }),
          readModels: () =>
            Effect.succeed({
              items: [
                {
                  id: model,
                  label: model,
                  efforts: [{ id: "high", label: "High" }],
                  effective_context_tokens: 100000,
                  max_context_tokens: 100000,
                  max_output_tokens: 1000,
                  input_modalities: ["text"],
                },
              ],
              next: null,
            }),
        };
        const catalog = yield* Models.discover().pipe(Effect.provideService(AlbedoClient, client));
        expect(catalog.models[0]?.slug).toBe("team%2Faccount/vendor%2Fmodel%251");
        expect(
          yield* Models.resolve({
            instanceId,
            model: catalog.defaultModel!,
            options: [{ id: "effort", value: "high" }],
          }).pipe(Effect.provideService(AlbedoClient, client)),
        ).toMatchObject({ profile, model, effort: "high" });
        expect(fake.creations).toHaveLength(0);
      }).pipe(Effect.scoped),
  );

  it.effect.each([
    { model: "missing/fixture-model" },
    { model: "fixture/removed-model" },
    { model: "%ZZ/model" },
    { model: "fixture/fixture-model", options: [{ id: "effort", value: "ultra" }] },
    { model: "fixture/fixture-model", options: [{ id: "effort", value: true }] },
    { model: "fixture/fixture-model", options: [{ id: "unsupported", value: "yes" }] },
  ])("rejects unavailable selections instead of replacing them: %j", (selection) =>
    Effect.gen(function* () {
      const fake = yield* fakeDaemon;
      const error = yield* Effect.flip(
        Models.resolve({ instanceId, ...selection }).pipe(
          Effect.provideService(AlbedoClient, fake.client),
        ),
      );
      expect(error._tag).toBe("AlbedoSelectionError");
      expect(fake.creations).toHaveLength(0);
    }).pipe(Effect.scoped),
  );
});
