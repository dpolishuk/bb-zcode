import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    executable: {
      type: "string",
      label: "ZCode executable",
      description:
        "Executable or zcode.cjs path. Empty: find zcode on PATH or the macOS ZCode app.",
      default: "",
    },
    args: {
      type: "string",
      label: "Extra launch arguments",
      description:
        "JSON array of arguments before app-server. No shell expansion.",
      default: "[]",
      experimental_schema: z.string().refine((value) => {
        try {
          return z.array(z.string()).safeParse(JSON.parse(value)).success;
        } catch {
          return false;
        }
      }, "Use a JSON array of strings."),
    },
    nodeExecutable: {
      type: "string",
      label: "Node executable",
      description: "Node 24+ executable used for a zcode.cjs bundle.",
      default: "node",
    },
  });
  let registered: ReturnType<BbPluginApi["providers"]["register"]> | undefined;
  function register(values: {
    executable: string;
    args: string;
    nodeExecutable: string;
  }) {
    const args = z.array(z.string()).parse(JSON.parse(values.args));
    const launch = {
      executable: values.executable,
      args,
      nodeExecutable: values.nodeExecutable,
    };
    registered?.dispose();
    registered = bb.providers.register({
      id: "zcode",
      displayName: "ZCode",
      icon: "Terminal",
      strings: {
        signInHint:
          "Sign in to individual Coding Plan in ZCode Desktop on this machine, or configure a personal API provider.",
        expiredHint:
          "Reconnect Coding Plan or check your personal API credentials in ZCode, then start a new session.",
        installUrl: "https://github.com/zai-org/ZCode",
        planModeCopy: "ZCode will inspect the workspace and prepare a plan.",
      },
      maintenance: { health: true, usage: false, installation: false },
      capabilities: {
        permissionModes: ["accept-edits", "auto", "full"],
        // This is bb's coarse validation ladder. model/list supplies each
        // model's actual choices; unknown/stale values use the native default.
        reasoningLevels: [
          "none",
          "low",
          "medium",
          "high",
          "xhigh",
          "ultracode",
          "max",
          "ultra",
        ],
        fork: "none",
        supportsNativeUserQuestion: true,
        supportsManualCompaction: false,
        supportsThreadArchive: false,
        supportsThreadRename: false,
        supportsServiceTier: false,
      },
      reasoningLevels: [{ id: "none", label: "Model default" }],
      composerActions: ["plan"],
      completedTurnDisplay: "flat",
      models: {
        fallback: [
          {
            id: "zcode-default",
            displayName: "ZCode models unavailable",
            isDefault: true,
            description:
              "Open ZCode on this machine, check the selected provider, then refresh the model list.",
            supportedReasoningEfforts: [
              {
                reasoningEffort: "none",
                description: "Use ZCode model defaults.",
              },
            ],
            defaultReasoningEffort: "none",
          },
        ],
        scope: "workspace",
      },
      env: { passthrough: ["BB_ZCODE_EXECUTABLE", "BB_ZCODE_NODE_EXECUTABLE"] },
      // Sessionless model/health probes also need launch settings. Re-registration
      // changes the bridge fingerprint so bb invalidates the old model catalog.
      experimental_bridgeOptions: launch,
    });
  }
  register(await settings.get());
  settings.onChange(register);
  bb.onDispose(() => registered?.dispose());
}
