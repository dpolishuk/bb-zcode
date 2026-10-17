import { expect, it } from "vitest";
import { experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import { modelForTurn, selectedModel, type Snapshot } from "../src/protocol.js";
import { resolveLaunch } from "../src/launch.js";

const snapshot: Snapshot = {
  session: { sessionId: "session" },
  settings: {
    model: {
      current: { providerId: "api", modelId: "model" },
      available: [
        {
          ref: { providerId: "api", modelId: "model" },
          label: "Model",
          reasoning: {
            levels: [
              { value: "disabled", label: "Off" },
              { value: "high", label: "High" },
            ],
            defaultLevel: "disabled",
          },
        },
      ],
    },
  },
};
it("supplies the native reasoning default when bb sends a placeholder or unknown value", () => {
  expect(
    modelForTurn(snapshot, "api/model", "none")?.options?.reasoningLevel,
  ).toBe("disabled");
  expect(modelForTurn(snapshot, "zcode-default")?.options?.reasoningLevel).toBe(
    "disabled",
  );
  expect(
    modelForTurn(snapshot, "api/model", "high")?.options?.reasoningLevel,
  ).toBe("high");
});
it("preserves slashes in native model ids and rejects ambiguous ids", () => {
  expect(selectedModel("api/org/model")).toEqual({
    providerId: "api",
    modelId: "org/model",
  });
  expect(() => selectedModel("unqualified")).toThrow("providerId/modelId");
});
it("passes executable arguments as an argv array without a shell", () => {
  const launch = resolveLaunch(
    {
      executable: "/path with spaces/zcode.cjs",
      args: ["literal; $(value)"],
      nodeExecutable: "/node 24",
    },
    { ELECTRON_RUN_AS_NODE: "1" },
  );
  expect(launch.command).toBe("/node 24");
  expect(launch.args).toEqual([
    "/path with spaces/zcode.cjs",
    "literal; $(value)",
    "app-server",
    "--stdio",
    "--surface",
    "terminal",
  ]);
  expect(launch.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
});
it("only imports public SDK surfaces and declared dependencies", async () => {
  const scan = await experimental_scanPublicSdkOnly(process.cwd());
  expect(scan.violations).toEqual([]);
  expect(scan.privateDependencies).toEqual([]);
});

it("pins both provider paths so account overlays use the CLI's builtin revision", () => {
  const launch = resolveLaunch(
    { executable: "/custom/zcode.cjs" },
    {
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "/custom/builtin.json",
      ZCODE_DATA_BASE_DIR: "/isolated",
    },
  );
  expect(launch.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE).toBe(
    "/isolated/.zcode/v2/provider_config.json",
  );
});
