import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";
import { AlbedoSettings } from "./settings.ts";

export const albedoClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("albedo"),
  label: "Albedo",
  settingsSchema: AlbedoSettings,
});
