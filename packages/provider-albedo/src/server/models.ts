import {
  type ModelSelection,
  type ProviderOptionDescriptor,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities, getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { AlbedoClient } from "./AlbedoClient.ts";
import type * as Protocol from "./protocol.ts";

export class AlbedoSelectionError extends Schema.TaggedError<AlbedoSelectionError>()(
  "AlbedoSelectionError",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail;
  }
}

export const modelSlug = (profile: string, model: string) =>
  `${encodeURIComponent(profile)}/${encodeURIComponent(model)}`;

const parseModel = Effect.fn("AlbedoModels.parse")(function* (slug: string) {
  const parts = slug.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return yield* new AlbedoSelectionError({
      detail: "Select an Albedo profile and model before starting work.",
    });
  }
  return yield* Effect.try({
    try: () => ({ profile: decodeURIComponent(parts[0]!), model: decodeURIComponent(parts[1]!) }),
    catch: () =>
      new AlbedoSelectionError({
        detail: "The saved Albedo model selection is invalid. Select its profile and model again.",
      }),
  });
});

const modelRow = (profile: string, model: typeof Protocol.Model.Type): ServerProviderModel => {
  const optionDescriptors: ProviderOptionDescriptor[] =
    model.efforts.length === 0
      ? []
      : [
          {
            id: "effort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "inherit", label: "Profile default", isDefault: true },
              { id: "default", label: "Model default" },
              ...model.efforts.filter(
                (effort) => effort.id !== "inherit" && effort.id !== "default",
              ),
            ],
          },
        ];
  return {
    slug: modelSlug(profile, model.id),
    name: model.label || model.id,
    subProvider: profile,
    isCustom: false,
    capabilities: createModelCapabilities({ optionDescriptors }),
  };
};

export const discover = Effect.fn("AlbedoModels.discover")(function* () {
  const client = yield* AlbedoClient;
  const settings = yield* client.readProviderSettings;
  const models: ServerProviderModel[] = [];
  for (const [profile, configuration] of Object.entries(settings.profiles)) {
    const seenPages = new Set<string>();
    const seenModels = new Set<string>();
    let next: string | undefined;
    do {
      const page = yield* client.readModels({ profile, ...(next === undefined ? {} : { next }) });
      for (const model of page.items) {
        if (seenModels.has(model.id)) continue;
        seenModels.add(model.id);
        models.push(modelRow(profile, model));
        if (models.length > 10000)
          return yield* new AlbedoSelectionError({
            detail: "Albedo's catalog exceeds T3's model limit.",
          });
      }
      next = page.next ?? undefined;
      if (next !== undefined) {
        if (seenPages.has(next) || seenPages.size >= 100 || models.length >= 10000) {
          return yield* new AlbedoSelectionError({
            detail:
              "Albedo's model catalog could not be read within its paging limit. Check the daemon catalog and refresh.",
          });
        }
        seenPages.add(next);
      }
    } while (next !== undefined);
    if (!seenModels.has(configuration.model)) {
      const page = yield* client.readModels({ profile, model: configuration.model });
      const selected = page.items.find((model) => model.id === configuration.model);
      if (selected !== undefined) models.push(modelRow(profile, selected));
    }
  }
  return {
    models,
    defaultModel:
      settings.default_profile === null
        ? undefined
        : settings.profiles[settings.default_profile] === undefined
          ? undefined
          : modelSlug(settings.default_profile, settings.profiles[settings.default_profile]!.model),
  };
});

export const resolve = Effect.fn("AlbedoModels.resolve")(function* (selection: ModelSelection) {
  if (
    selection.options?.some((option) => option.id !== "effort" || typeof option.value !== "string")
  ) {
    return yield* new AlbedoSelectionError({
      detail:
        "This Albedo selection contains an unsupported option. Select supported options before retrying.",
    });
  }
  const client = yield* AlbedoClient;
  const settings = yield* client.readProviderSettings;
  const chosen = selection.model === "default" ? null : yield* parseModel(selection.model);
  const profile = chosen?.profile ?? settings.default_profile;
  if (profile === null || settings.profiles[profile] === undefined) {
    return yield* new AlbedoSelectionError({
      detail:
        "The selected Albedo profile is unavailable. Configure it in Albedo or select another profile in T3.",
    });
  }
  const model = chosen?.model ?? settings.profiles[profile]!.model;
  const metadata = (yield* client.readModels({ profile, model })).items.find(
    (entry) => entry.id === model,
  );
  if (metadata === undefined)
    return yield* new AlbedoSelectionError({
      detail: "Albedo did not confirm the selected model. Refresh the catalog before retrying.",
    });
  const effort = getModelSelectionStringOptionValue(selection, "effort") ?? "inherit";
  if (
    effort !== "inherit" &&
    effort !== "default" &&
    !metadata.efforts.some((level) => level.id === effort)
  ) {
    return yield* new AlbedoSelectionError({
      detail:
        "The selected reasoning level is unavailable for this Albedo model. Choose a supported level.",
    });
  }
  return { profile, model, effort, contextWindow: metadata.effective_context_tokens };
});
