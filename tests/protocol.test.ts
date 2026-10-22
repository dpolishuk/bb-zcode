import { expect, it } from "vitest";
import { experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import {
  baseModelId,
  modelContextWindow,
  modelForTurn,
  selectedModel,
  type Snapshot,
} from "../src/protocol.js";
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

it("preserves saved native model options when changing reasoning", () => {
  const current = {
    ...snapshot,
    settings: {
      model: {
        ...snapshot.settings.model,
        current: {
          providerId: "api",
          modelId: "model",
          options: { reasoningLevel: "disabled", maxOutputTokens: 8000 },
        },
      },
    },
  };
  expect(modelForTurn(current, "api/model", "high")?.options).toEqual({
    maxOutputTokens: 8000,
    reasoningLevel: "high",
  });
});

it("runs context-budget variants on the base model with the variant's reasoning", () => {
  const wide: Snapshot = {
    ...snapshot,
    settings: {
      model: {
        current: { providerId: "api", modelId: "model" },
        available: [
          {
            ref: { providerId: "api", modelId: "model" },
            label: "Model",
            contextWindow: 1000000,
            reasoning: snapshot.settings.model.available[0].reasoning,
          },
        ],
      },
    },
  };
  expect(modelForTurn(wide, "api/model-256k", "high")).toEqual({
    providerId: "api",
    modelId: "model",
    options: { reasoningLevel: "high" },
  });
  expect(
    modelContextWindow(wide, { providerId: "api", modelId: "model-256k" }),
  ).toBe(256000);
  expect(modelContextWindow(wide)).toBe(1000000);
  // A budget can only shrink the advertised window, never enlarge it.
  const narrow: Snapshot = {
    ...wide,
    settings: {
      model: {
        current: { providerId: "api", modelId: "model" },
        available: [
          {
            ref: { providerId: "api", modelId: "model" },
            label: "Model",
            contextWindow: 200000,
          },
        ],
      },
    },
  };
  expect(
    modelContextWindow(narrow, { providerId: "api", modelId: "model-256k" }),
  ).toBe(200000);
  expect(baseModelId("GLM-5.3-256k")).toBe("GLM-5.3");
  expect(baseModelId("GLM-5.3")).toBe("GLM-5.3");
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
