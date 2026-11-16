import { EnvironmentId } from "@t3tools/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";
import "~/index.css";

import { render } from "../../../test/render";

const updateSettings = vi.hoisted(() => vi.fn());

vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useUpdateEnvironmentSettings: (() => updateSettings) as never,
}));
vi.mock(import("./SecretSourceInput"), async (original) => ({
  ...(await original()),
  useSecretSources: () => [],
}));

import { AddUsageLimitSourceDialog } from "./AddUsageLimitSourceDialog";

describe("AddUsageLimitSourceDialog", () => {
  it.each([
    {
      service: "CLIProxyAPI hub",
      id: "cliproxy-hub.example.ts.net-8318",
      url: "https://hub.example.ts.net:8318",
      kind: "cliproxy",
    },
    {
      service: "DeepSeek",
      id: "deepseek-api.deepseek.com",
      url: "https://api.deepseek.com",
      kind: "deepseek",
    },
    {
      service: "GLM Coding Plan",
      id: "zai-coding-api.z.ai",
      url: "https://api.z.ai",
      kind: "zai-coding",
    },
    {
      service: "GLM prepaid API",
      id: "zai-api-api.z.ai",
      url: "https://api.z.ai",
      kind: "zai-api",
    },
    {
      service: "Abliteration",
      id: "abliteration-api.abliteration.ai",
      url: "https://api.abliteration.ai",
      kind: "abliteration",
    },
  ])(
    "adds $service with the correct endpoint and credential",
    async ({ service, id, url, kind }) => {
      updateSettings.mockClear();
      const onOpenChange = vi.fn();
      await using _screen = await render(
        <AddUsageLimitSourceDialog
          open
          onOpenChange={onOpenChange}
          environmentId={EnvironmentId.make("local")}
          environmentLabel="This Mac"
          sources={{}}
        />,
      );

      if (kind === "cliproxy") {
        await userEvent.type(page.getByLabelText("Hub URL"), url);
        await userEvent.type(page.getByLabelText("Management key"), "secret-key{Enter}");
      } else {
        await userEvent.type(page.getByLabelText("Management key"), "old-service-secret");
        await page.getByRole("combobox", { name: "Service" }).click();
        await page.getByRole("option", { name: service, exact: true }).click();
        await expect.element(page.getByLabelText("API key")).toHaveValue("");
        await expect.element(page.getByRole("button", { name: "Add source" })).toBeDisabled();
        await userEvent.type(page.getByLabelText("API key"), "secret-key{Enter}");
      }

      expect(updateSettings).toHaveBeenCalledOnce();
      expect(updateSettings).toHaveBeenCalledWith({
        usageLimitSources: {
          [id]: expect.objectContaining({
            kind,
            url,
            managementKey: "secret-key",
          }),
        },
      });
      expect(onOpenChange).toHaveBeenCalledWith(false);
    },
  );
});
