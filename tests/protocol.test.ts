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
  expect(baseModelId(wide, { providerId: "api", modelId: "model-256k" })).toBe(
    "model",
  );
  expect(baseModelId(wide, { providerId: "api", modelId: "model" })).toBe(
    "model",
  );
});
it.each(["model-256k", "org/model-256k", "model-bb-context-256k"])(
  "preserves the canonical native model ID %s",
  (modelId) => {
    const native: Snapshot = {
      session: { sessionId: "native" },
      settings: {
        model: {
          current: { providerId: "api", modelId },
          available: [
            {
              ref: { providerId: "api", modelId },
              label: "Native model",
              contextWindow: 262144,
            },
          ],
        },
      },
    };
    expect(modelForTurn(native, `api/${modelId}`)?.modelId).toBe(modelId);
    expect(modelForTurn(native, "zcode-default")?.modelId).toBe(modelId);
    expect(modelContextWindow(native)).toBe(262144);
  },
);

it("resolves budget aliases within the selected provider", () => {
  const catalog: Snapshot = {
    session: { sessionId: "native" },
    settings: {
      model: {
        available: [
          {
            ref: { providerId: "one", modelId: "model" },
            label: "Wide",
            contextWindow: 1000000,
          },
          {
            ref: { providerId: "two", modelId: "model-256k" },
            label: "Native",
            contextWindow: 262144,
          },
        ],
      },
    },
  };
  expect(modelForTurn(catalog, "one/model-256k")?.modelId).toBe("model");
  expect(modelForTurn(catalog, "two/model-256k")?.modelId).toBe("model-256k");
});

it("preserves unknown suffix-shaped IDs rather than guessing their base", () => {
  expect(modelForTurn(snapshot, "api/unknown-256k")?.modelId).toBe(
    "unknown-256k",
  );
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
  // Beyond the SDK's fixed allowlist: cron-parser computes automation
  // schedules in src/automations.ts, and app.tsx imports react hooks at
  // runtime - the bb app bundle build shims react from the shared plugin
  // runtime (globalThis.__bbPluginRuntime.react), never from node_modules.
  const scan = await experimental_scanPublicSdkOnly(process.cwd(), {
    allow: [/^cron-parser$/u, /^react$/u],
  });
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
