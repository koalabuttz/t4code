import { TextGenerationError, type ServerProvider } from "@t3tools/contracts";
import type { IdAllocatorV2 } from "@t3tools/provider-core/server/IdAllocator";
import type { McpProviderSessions } from "@t3tools/provider-core/server/McpProviderSessions";
import { ProviderHost } from "@t3tools/provider-core/server/ProviderHost";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
} from "@t3tools/provider-core/server/driver";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
} from "@t3tools/provider-core/server/snapshotSettings";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as HttpClient from "effect/http/HttpClient";

import { AlbedoSettings } from "../settings.ts";
import * as Client from "./AlbedoClient.ts";
import * as InputStore from "./AlbedoInputStore.ts";
import * as CompactionStore from "./AlbedoCompactionStore.ts";
import * as SessionStore from "./AlbedoSessionStore.ts";
import * as NativeOutcomes from "./AlbedoNativeOutcomes.ts";
import { makeAdapter } from "./adapter.ts";
import * as Models from "./models.ts";
import { driver } from "./turnProjection.ts";

const decodeSettings = Schema.decodeSync(AlbedoSettings);
const unsupportedGeneration = Effect.fn("AlbedoDriver.textGeneration")(() =>
  Effect.fail(
    new TextGenerationError({
      operation: "albedo",
      detail:
        "Albedo does not yet support T3's standalone text generation. Select another provider for this operation.",
    }),
  ),
);
const textGeneration = {
  generateTranscriptionPostProcessing: unsupportedGeneration,
  generateCommitMessage: unsupportedGeneration,
  generatePrContent: unsupportedGeneration,
  generateBranchName: unsupportedGeneration,
  generateThreadTitle: unsupportedGeneration,
  generateReviewGuide: unsupportedGeneration,
} satisfies ProviderTextGeneration;

export type AlbedoDriverEnv =
  | ProviderHost
  | McpProviderSessions
  | IdAllocatorV2
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient;

export const AlbedoDriver: ProviderDriver<AlbedoSettings, AlbedoDriverEnv> = {
  driverKind: driver,
  metadata: { displayName: "Albedo", supportsMultipleInstances: true },
  configSchema: AlbedoSettings,
  defaultConfig: () => decodeSettings({}),
  create: Effect.fn("AlbedoDriver.create")(
    function* (input) {
      const host = yield* ProviderHost;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const http = yield* HttpClient.HttpClient;
      const home = yield* HostProcess.HomeDirectory;
      const environment = yield* mergeProviderInstanceEnvironment(input.environment);
      const homeDirectory = path.resolve(
        expandHomePath(
          input.config.homeDirectory ||
            environment.ALBEDO_HOME ||
            path.join(environment.HOME ?? home, ".albedo"),
          home,
        ),
      );
      const clientLayer = Client.layer(homeDirectory).pipe(
        Layer.provide([
          Layer.succeed(FileSystem.FileSystem, fs),
          Layer.succeed(Path.Path, path),
          Layer.succeed(HttpClient.HttpClient, http),
        ]),
      );
      const connect = Client.AlbedoClient.pipe(Effect.provide(clientLayer));
      const directory = path.join(host.paths.stateDir, "providers", "albedo");
      yield* fs.makeDirectory(directory, { recursive: true });
      const stores = yield* Layer.build(
        Layer.mergeAll(
          InputStore.layer,
          SessionStore.layer,
          NativeOutcomes.layer,
          CompactionStore.layer,
        ).pipe(
          Layer.provide([
            SecureRandom.layerWebCrypto,
            NodeSqliteClient.layer({
              filename: path.join(directory, `${encodeURIComponent(input.instanceId)}.sqlite`),
              readerWorker: false,
              writerWorker: false,
            }),
          ]),
        ),
      );
      const orchestrationAdapter = yield* makeAdapter({
        instanceId: input.instanceId,
        homeDirectory,
        connect,
      }).pipe(Effect.provide(stores));
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: driver,
        instanceId: input.instanceId,
      });
      const initial = Effect.gen(function* () {
        return {
          instanceId: input.instanceId,
          driver,
          ...(input.displayName ? { displayName: input.displayName } : {}),
          ...(input.accentColor ? { accentColor: input.accentColor } : {}),
          continuation: { groupKey: continuationIdentity.continuationKey },
          enabled: input.enabled,
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          checkedAt: DateTime.formatIso(yield* DateTime.now),
          models: [],
          slashCommands: [],
          skills: [],
          supportedRuntimeModes: ["full-access"],
          showInteractionModeToggle: false,
          supportsConversationRollback: false,
          supportsTextGeneration: false,
          reportsContextWindow: true,
          setup: {
            canAuthenticate: false,
            canInstall: false,
            documentationUrl: "https://albedo.sh",
          },
          message: input.enabled
            ? "Connecting to the Albedo daemon on this environment..."
            : "Albedo is disabled in T3 Code settings.",
        } satisfies ServerProvider;
      });
      let lastModels: ServerProvider["models"] = [];
      const checkProvider = Effect.gen(function* () {
        const base = yield* initial;
        if (!input.enabled) return base;
        return yield* Effect.gen(function* () {
          const client = yield* connect;
          const catalog = yield* Models.discover().pipe(
            Effect.provideService(Client.AlbedoClient, client),
          );
          const { message: _message, ...ready } = base;
          lastModels = catalog.models.map((model) =>
            model.slug === catalog.defaultModel ? { ...model, isDefault: true } : model,
          );
          return {
            ...ready,
            installed: true,
            status: "ready" as const,
            auth: { status: "unknown" as const },
            models: lastModels,
          } satisfies ServerProvider;
        }).pipe(
          Effect.catch((cause) =>
            Effect.succeed({
              ...base,
              models: lastModels,
              status: "error" as const,
              message: cause.message,
            }),
          ),
        );
      });
      const settings = yield* makeProviderSnapshotSettingsSource({
        ...input.config,
        enabled: input.enabled,
      });
      const snapshot = yield* makeManagedServerProvider({
        getSettings: settings.getSettings,
        streamSettings: settings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: () => initial,
        checkProvider,
        resolveMaintenance: Effect.fn("AlbedoDriver.maintenance")(() =>
          Effect.succeed({ provider: driver, packageName: null, update: null }),
        ),
      });
      return {
        instanceId: input.instanceId,
        driverKind: driver,
        displayName: input.displayName,
        accentColor: input.accentColor,
        enabled: input.enabled,
        continuationIdentity,
        orchestrationAdapter,
        textGeneration,
        snapshot,
      };
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver,
              instanceId: input.instanceId,
              detail: "Could not initialize Albedo's provider state.",
              cause,
            }),
        ),
      ),
  ),
};
