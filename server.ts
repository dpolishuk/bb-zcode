import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { parseMcpServers } from "./src/settings.js";
import { parseSubagents } from "./src/subagents.js";
import { workflowGraphPayloadSchema } from "./src/timeline.js";
import {
  WorkflowRunsReader,
  readWorkflowRuns,
  runRowView,
} from "./src/runs.js";
import { workflowRunsRpcContract } from "./src/runsContract.js";

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
    automationsEnabled: {
      type: "boolean",
      label: "ZCode automations",
      description:
        "Let ZCode sessions create scheduled tasks (CronCreate) and run them in this bb while it is open. Applies to new sessions.",
      default: false,
    },
    offPeakTasksEnabled: {
      type: "boolean",
      label: "ZCode idle-time tasks",
      description:
        "Let ZCode sessions queue idle-time (off-peak) tasks on the Z.ai server and run them when it grants capacity. Requires an individual Coding Plan; runs consume plan quota. Applies to new sessions.",
      default: false,
    },
    dynamicWorkflowsEnabled: {
      type: "boolean",
      label: "ZCode dynamic workflows",
      description:
        "Let ZCode sessions author and run dynamic workflows (CreateWorkflow multi-agent orchestration). Workflow subagents run in the background of this bb and consume plan quota. Applies to new sessions.",
      default: false,
    },
  });
  let registered: ReturnType<BbPluginApi["providers"]["register"]> | undefined;
  // Launch options captured for the sessionless run-history reader (the
  // run hub / thread pane RPC below); register() refreshes them per settings.
  let launchOptions = {
    executable: "",
    args: [] as string[],
    nodeExecutable: "node",
  };
  function register(values: {
    executable: string;
    args: string;
    nodeExecutable: string;
    memoryEnabled: boolean;
    nativeSearchEnhancementsEnabled: boolean;
    mcpServers: string;
    subagents: string;
    bbToolsEnabled: boolean;
    automationsEnabled: boolean;
    offPeakTasksEnabled: boolean;
    dynamicWorkflowsEnabled: boolean;
  }) {
    const args = z.array(z.string()).parse(JSON.parse(values.args));
    launchOptions = {
      executable: values.executable,
      args,
      nodeExecutable: values.nodeExecutable,
    };
    const launch = {
      executable: values.executable,
      args,
      nodeExecutable: values.nodeExecutable,
      memoryEnabled: values.memoryEnabled,
      nativeSearchEnhancementsEnabled: values.nativeSearchEnhancementsEnabled,
      mcpServers: values.mcpServers,
      subagents: values.subagents,
      bbToolsEnabled: values.bbToolsEnabled,
      automationsEnabled: values.automationsEnabled,
      offPeakTasksEnabled: values.offPeakTasksEnabled,
      dynamicWorkflowsEnabled: values.dynamicWorkflowsEnabled,
    };
    registered?.dispose();
    registered = bb.providers.register({
      id: "zcode",
      displayName: "ZCode",
      icon: "./icons/zcode.svg",
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
        supportsThreadArchive: true,
        supportsThreadRename: true,
        supportsServiceTier: false,
      },
      reasoningLevels: [{ id: "none", label: "Model default" }],
      composerActions: ["plan"],
      completedTurnDisplay: "flat",
      // The dynamic-workflow graph row: the bridge emits items of the wire
      // kind "zcode/workflow-graph" and the plugin frontend renders them
      // (experimental_timelineRenderer). Payloads are validated at ingest.
      extensionKinds: {
        "workflow-graph": { item: workflowGraphPayloadSchema },
      },
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

  // Sidebar hub + thread run pane read run history through this RPC. The
  // persisted run store outlives any thread's CLI process, so a short-lived
  // sessionless CLI read answers for any workspace (POC-verified cold read);
  // reads are single-flight with a short TTL because a spawn is the cost.
  const runsReader = new WorkflowRunsReader((cwd, limit) =>
    readWorkflowRuns(launchOptions, process.env, cwd, limit),
  );
  const resolveWorkspace = async (input: {
    threadId?: string;
    projectId?: string;
  }): Promise<string> => {
    if (input.threadId) {
      const thread = await bb.sdk.threads.get({
        threadId: input.threadId,
      });
      const environmentId =
        typeof thread.environmentId === "string" ? thread.environmentId : null;
      if (!environmentId)
        throw new Error("This thread has no environment checkout yet.");
      const environment = await bb.sdk.environments.get({ environmentId });
      if (!environment.path)
        throw new Error("This thread's environment has no local path.");
      return environment.path;
    }
    if (input.projectId) {
      const environments = await bb.sdk.environments.list({
        projectId: input.projectId,
      });
      const withPath = environments.filter(
        (environment) => environment.path && environment.status === "ready",
      );
      // The project's own checkout beats managed worktrees for "the runs of
      // this project" - worktree runs list under their own path key.
      const own =
        withPath.find(
          (environment) =>
            environment.workspaceProvisionType !== "managed-worktree",
        ) ?? withPath[0];
      if (!own?.path)
        throw new Error("This project has no ready environment checkout.");
      return own.path;
    }
    throw new Error("Pass a threadId or projectId to locate the workspace.");
  };
  bb.rpc.register(
    workflowRunsRpcContract,
    {
      workflowRuns: async (input) => {
        const workspace = await resolveWorkspace(input);
        const limit = input.limit ?? 50;
        const snapshot = await runsReader.read(workspace, limit, false);
        return {
          runs: snapshot.runs.slice(0, limit).map(runRowView),
          truncated: snapshot.truncated,
        };
      },
    },
    {
      experimental_description:
        "ZCode dynamic-workflow run history for this workspace (sessionless cold read).",
    },
  );
}
