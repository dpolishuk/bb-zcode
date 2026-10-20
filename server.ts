import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { parseMcpServers } from "./src/settings.js";
import { parseSubagents } from "./src/subagents.js";

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
    memoryEnabled: {
      type: "boolean",
      label: "ZCode memory",
      description:
        "Allow ZCode to save and recall its native workspace memory in new sessions.",
      default: false,
    },
    nativeSearchEnhancementsEnabled: {
      type: "boolean",
      label: "Enhanced native search",
      description:
        "Enable ZCode's native find and grep enhancements in new sessions.",
      default: false,
    },
    mcpServers: {
      type: "string",
      label: "MCP servers",
      description:
        "JSON array of ZCode protocol server definitions. Empty: inherit native CLI configuration.",
      default: "[]",
      experimental_schema: z.string().refine((value) => {
        try {
          parseMcpServers(value);
          return true;
        } catch {
          return false;
        }
      }, "Use a JSON array of ZCode MCP server definitions."),
    },
    subagents: {
      type: "string",
      label: "Custom subagents",
      description:
        "Native subagent configuration as JSON. Empty: inherit ZCode's native agent configuration. Applies to new sessions and resume.",
      default: "",
      experimental_schema: z.string().refine((value) => {
        try {
          parseSubagents(value);
          return true;
        } catch {
          return false;
        }
      }, "Use a native subagent configuration snapshot."),
    },
    bbToolsEnabled: {
      type: "boolean",
      label: "bb plugin tools",
      description:
        "Expose bb tools to ZCode. Overrides the CLI MCP server list; list other custom servers in MCP servers above. Applies to new sessions.",
      default: false,
    },
  });
  let registered: ReturnType<BbPluginApi["providers"]["register"]> | undefined;
  function register(values: {
    executable: string;
    args: string;
    nodeExecutable: string;
    memoryEnabled: boolean;
    nativeSearchEnhancementsEnabled: boolean;
    mcpServers: string;
    subagents: string;
    bbToolsEnabled: boolean;
  }) {
    const args = z.array(z.string()).parse(JSON.parse(values.args));
    const launch = {
      executable: values.executable,
      args,
      nodeExecutable: values.nodeExecutable,
      memoryEnabled: values.memoryEnabled,
      nativeSearchEnhancementsEnabled: values.nativeSearchEnhancementsEnabled,
      mcpServers: values.mcpServers,
      subagents: values.subagents,
      bbToolsEnabled: values.bbToolsEnabled,
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
      maintenance: { health: true, usage: true, installation: false },
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
        fork: "checkpoint",
        supportsNativeUserQuestion: true,
        supportsManualCompaction: true,
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
