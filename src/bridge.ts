import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  initializeParamsSchema,
  modelListParamsSchema,
  providerMaintenanceParamsSchema,
  threadStartParamsSchema,
  threadResumeParamsSchema,
  threadForkParamsSchema,
  threadStopParamsSchema,
  threadDiscardParamsSchema,
  threadArchiveParamsSchema,
  threadUnarchiveParamsSchema,
  threadNameSetParamsSchema,
  threadGoalClearParamsSchema,
  turnStartParamsSchema,
  turnSteerParamsSchema,
  skillsConfigureParamsSchema,
  decodeToolCallResponsePayload,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  interactionRequestPayloadSchema,
  approvalInteractionOutcomeSchema,
  type BridgeExecutionOptions,
  type PromptInput,
  type ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  ZCodeClient,
  ProtocolError,
  type Frame,
  type ClientCallbacks,
  type ZCodeConnection,
} from "./client.js";
import { resolveLaunch, workspaceRef, type LaunchSpec } from "./launch.js";
import {
  record,
  text,
  snapshotSchema,
  eventSchema,
  DEFAULT_MODEL,
  RUNTIME_PREFERENCES,
  modelForTurn,
  modelContextWindow,
  formatContextWindow,
  baseModelId,
  contextBudgetVariants,
  selectedModel,
  type Snapshot,
} from "./protocol.js";
import { Timeline, toolPresentation } from "./timeline.js";
import { CodingPlanHost, type AccountHost } from "./coding-plan.js";
import { nativeInput } from "./input.js";
import { Usage } from "./usage.js";
import { runtimeSettings } from "./settings.js";
import { skillCatalog } from "./skills.js";
import type { Subagents } from "./subagents.js";
import {
  createToolServer,
  type ToolServer,
  type BbTool,
  type ToolResult,
} from "./tool-server.js";

import { History, BackgroundWork, managementCommands } from "./lifecycle.js";
import {
  AUTOMATION_METHODS,
  CRON_TOOL_NAMES,
  createAutomationService,
  dispatchPermissionMode,
  type AutomationService,
  type StoredAutomation,
} from "./automations.js";
import {
  OFF_PEAK_METHODS,
  OFF_PEAK_RUN_TOOL_DENYLIST,
  OFF_PEAK_CONTINUATION_PROMPT,
  createOffPeakService,
  createOffPeakServerClient,
  type OffPeakServerClient,
  type OffPeakService,
  type StoredOffPeakTask,
} from "./offpeak.js";

type Message = Record<string, unknown>;

/** Native host-service ports that bb's provider bridge cannot serve. */
function hostServiceUnavailable(method: string): string | undefined {
  if (
    method === "interaction/browserList" ||
    method === "interaction/browserExecute"
  )
    return "Browser control";
  if (method.startsWith("offPeak/")) return "ZCode Off-Peak tasks (disabled)";
  if (method === "bot/channel/reply") return "ZCode topic resources";
  if (method.startsWith("mcp/ui")) return "ZCode MCP Apps";
  return undefined;
}
type Session = {
  threadId: string;
  providerThreadId: string;
  client: ZCodeConnection;
  account: AccountHost;
  accountError?: string;
  cwd: string;
  timeline?: Timeline;
  starting: boolean;
  buffered: Frame[];
  stopping: boolean;
  instructions?: string;
  lastSeq: number;
  mode: string;
  restorable: boolean;
  snapshot: Snapshot;
  usage: Usage;
  activeTurnId?: string;
  /** Last accepted bb selection; budgets also apply to native-origin turns. */
  contextModel?: { providerId: string; modelId: string };
  history: History;
  background: BackgroundWork;
  beforeRowId: number;
  compacting: boolean;
  draining: boolean;
  queue: Array<z.infer<typeof turnSteerParamsSchema>>;
  accepted: Set<string>;
  toolServer?: ToolServer;
  skills?: string;
  injectedNativeCalls: Set<string>;
  /** Launch/provider options snapshot for headless automation dispatch. */
  providerOptions?: unknown;
  /** Set while a scheduled-task turn runs; settle() reports it to the store. */
  dispatchingAutomationId?: string;
  /** Set while an idle-time-task turn runs; settle() reports the outcome. */
  dispatchingOffPeakId?: string;
  /** True when the dispatcher constructed this session and owns its release. */
  automationOwned?: boolean;
};
type ClientFactory = (
  launch: LaunchSpec,
  cwd: string,
  callbacks: ClientCallbacks,
  threadId: string | null,
) => ZCodeConnection;
const schemas: Record<string, z.ZodType> = {
  initialize: initializeParamsSchema,
  "model/list": modelListParamsSchema,
  "provider/health": providerMaintenanceParamsSchema,
  "provider/usage": providerMaintenanceParamsSchema,
  "thread/start": threadStartParamsSchema,
  "thread/resume": threadResumeParamsSchema,
  "thread/fork": threadForkParamsSchema,
  "thread/stop": threadStopParamsSchema,
  "thread/discard": threadDiscardParamsSchema,
  "thread/archive": threadArchiveParamsSchema,
  "thread/unarchive": threadUnarchiveParamsSchema,
  "thread/name/set": threadNameSetParamsSchema,
  "thread/goal/clear": threadGoalClearParamsSchema,
  "turn/start": turnStartParamsSchema,
  "turn/steer": turnSteerParamsSchema,
  "skills/configure": skillsConfigureParamsSchema,
};
const modeFor = (options: BridgeExecutionOptions) =>
  options.promptMode === "plan"
    ? "plan"
    : options.permissionMode === "full"
      ? "yolo"
      : "build";

/** The native probe performs one real model request; keep it explicit. */
async function checkConnectivity(session: Session, argument: string) {
  const selection = argument
    ? selectedModel(argument)
    : session.snapshot.settings.model.current;
  if (!selection)
    throw new ProtocolError(
      "No ZCode model is selected. Pick a model, then run /zcode-check.",
      -32000,
    );
  // Budget variants have no native registry entry; test their base model.
  const native = {
    ...selection,
    modelId: baseModelId(session.snapshot, selection),
  };
  await session.client.request(
    "provider/testModelConnectivity",
    { workspace: workspaceRef(session.cwd), selection: native },
    60_000,
  );
  return `ZCode verified connectivity for ${native.providerId}/${native.modelId}. This ran one real model request.`;
}

const USAGE = [
  "Usage:",
  "/zcode-plugin list",
  "/zcode-plugin install <name> <marketplace>",
  "/zcode-plugin update [plugin-id]",
  "/zcode-plugin uninstall <plugin-id>",
  "/zcode-plugin enable <plugin-id>",
  "/zcode-plugin disable <plugin-id>",
  "/zcode-plugin marketplace add <source>",
  "/zcode-plugin marketplace update [name]",
  "/zcode-plugin marketplace remove <name>",
].join("\n");

const clip = (value: string, limit = 2000) => value.slice(0, limit);

/** Renders only fields the native reply actually carries. */
function pluginReport(raw: unknown): string {
  const result = record(raw);
  const lines: string[] = [];
  const installed = Array.isArray(result.installedPlugins)
    ? result.installedPlugins.map(record)
    : [];
  for (const plugin of installed.slice(0, 50))
    lines.push(
      clip(
        `${text(plugin.name)} (${text(plugin.id)})${
          text(plugin.version) ? ` @ ${text(plugin.version)}` : ""
        }${plugin.enabled === false ? " [disabled]" : ""}`,
      ),
    );
  if (installed.length > 50) lines.push(`…and ${installed.length - 50} more`);
  if (
    Array.isArray(result.dependencyClosure) &&
    result.dependencyClosure.length
  )
    lines.push(
      `Dependency closure: ${result.dependencyClosure.length} plugin(s).`,
    );
  for (const diagnostic of (Array.isArray(result.diagnostics)
    ? result.diagnostics.map(record)
    : []
  ).slice(0, 20)) {
    const message = text(diagnostic.message) || text(diagnostic.summary);
    if (message) lines.push(clip(`Diagnostic: ${message}`));
  }
  if (!lines.length)
    lines.push("ZCode accepted the operation with no further detail.");
  return lines.join("\n");
}

/**
 * Native ZCode plugin management. These commands mutate ZCode's own plugin
 * configuration and run inside its trust boundary, exactly as if performed
 * from ZCode itself; the bridge adds no additional review.
 */
async function managePlugins(session: Session, argument: string) {
  const parts = argument.split(/\s+/).filter(Boolean);
  const action = parts[0] ?? "";
  const workspace = workspaceRef(session.cwd);
  const timeoutMs = 120_000;
  const call = (method: string, params: Record<string, unknown>) =>
    session.client.request(method, { workspace, ...params }, timeoutMs);
  switch (action) {
    case "list": {
      const result = record(await call("plugins/list", {}));
      const plugins = Array.isArray(result.plugins)
        ? result.plugins.map(record)
        : [];
      if (!plugins.length) return "No ZCode plugins are installed.";
      const lines = plugins
        .slice(0, 50)
        .map((plugin) =>
          clip(
            `${text(plugin.name)} (${text(plugin.id)})${
              text(plugin.version) ? ` @ ${text(plugin.version)}` : ""
            }${plugin.enabled === false ? " [disabled]" : ""}` +
              (text(plugin.description)
                ? ` - ${text(plugin.description)}`
                : ""),
          ),
        );
      if (plugins.length > 50) lines.push(`…and ${plugins.length - 50} more`);
      for (const diagnostic of (Array.isArray(result.diagnostics)
        ? result.diagnostics.map(record)
        : []
      ).slice(0, 20)) {
        const message = text(diagnostic.message) || text(diagnostic.summary);
        if (message) lines.push(clip(`Diagnostic: ${message}`));
      }
      return lines.join("\n");
    }
    case "install": {
      if (parts.length < 3)
        throw new ProtocolError(
          "Usage: /zcode-plugin install <name> <marketplace>",
          -32000,
        );
      return pluginReport(
        await call("plugins/install", {
          pluginName: parts[1],
          marketplace: parts[2],
        }),
      );
    }
    case "update":
      return pluginReport(
        await call("plugins/update", parts[1] ? { pluginId: parts[1] } : {}),
      );
    case "uninstall":
      if (parts.length < 2)
        throw new ProtocolError(
          "Usage: /zcode-plugin uninstall <plugin-id>",
          -32000,
        );
      return pluginReport(
        await call("plugins/uninstall", { pluginId: parts[1] }),
      );
    case "enable":
    case "disable": {
      if (parts.length < 2)
        throw new ProtocolError(
          `Usage: /zcode-plugin ${action} <plugin-id>`,
          -32000,
        );
      await call("plugins/setEnabled", {
        pluginId: parts[1],
        enabled: action === "enable",
      });
      return `ZCode ${action === "enable" ? "enabled" : "disabled"} ${parts[1]}.`;
    }
    case "marketplace":
      switch (parts[1]) {
        case "add":
          if (parts.length < 3)
            throw new ProtocolError(
              "Usage: /zcode-plugin marketplace add <source>",
              -32000,
            );
          return pluginReport(
            await call("plugins/marketplace/add", { source: parts[2] }),
          );
        case "update":
          return pluginReport(
            await call(
              "plugins/marketplace/update",
              parts[2] ? { marketplace: parts[2] } : {},
            ),
          );
        case "remove":
          if (parts.length < 3)
            throw new ProtocolError(
              "Usage: /zcode-plugin marketplace remove <name>",
              -32000,
            );
          return pluginReport(
            await call("plugins/marketplace/remove", { marketplace: parts[2] }),
          );
        default:
          throw new ProtocolError(
            "Usage: /zcode-plugin marketplace add|update|remove …",
            -32000,
          );
      }
    default:
      throw new ProtocolError(USAGE, -32000);
  }
}

async function manageAutomations(
  service: AutomationService,
  cwd: string,
  command: string,
  argument: string,
) {
  // Scheduled tasks are workspace-scoped like the native per-workspace
  // index; the command shows and deletes this session's workspace only.
  if (command === "zcode-automations") return service.describe(cwd);
  const id = argument.trim();
  if (!id)
    throw new ProtocolError(
      "Usage: /zcode-automation-delete <automation-id>",
      -32000,
    );
  if (!(await service.removeById(id, cwd)))
    throw new ProtocolError(`No scheduled task ${id}.`, -32000);
  return `Deleted scheduled task ${id}.`;
}

async function manageOffPeakTasks(
  service: OffPeakService,
  cwd: string,
  command: string,
  argument: string,
) {
  if (command === "zcode-offpeak") return service.describe(cwd);
  const id = argument.trim();
  if (!id)
    throw new ProtocolError("Usage: /zcode-offpeak-cancel <task-id>", -32000);
  if (!(await service.cancel(id, cwd)))
    throw new ProtocolError(`No idle-time task ${id}.`, -32000);
  return `Cancelled idle-time task ${id}.`;
}

export function createBridge(
  config: {
    write?: (message: Message) => void;
    clientFactory?: ClientFactory;
    env?: NodeJS.ProcessEnv;
    accountFactory?: (launch: LaunchSpec) => AccountHost;
    automationTickMs?: number;
    /** Test seam: replace the off-peak gateway client entirely. */
    offPeakClientFactory?: () => OffPeakServerClient;
  } = {},
) {
  const write =
    config.write ??
    ((message) => {
      process.stdout.write(JSON.stringify(message) + "\n");
    });
  const factory =
    config.clientFactory ??
    ((launch, cwd, callbacks, threadId) =>
      new ZCodeClient(launch, cwd, callbacks, threadId));
  const sessions = new Map<string, Session>();
  const constructing = new Set<string>();
  const startingClients = new Map<string, ZCodeConnection>();
  const clients = new Set<ZCodeConnection>();
  const accounts = new Map<ZCodeConnection, AccountHost>();
  let skills = "";
  const toolCalls = new Map<
    string,
    {
      session: Session;
      resolve(value: ToolResult): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const interactions = new Map<
    string,
    {
      session: Session;
      resolve(value: unknown): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let closed = false;
  // Scheduled tasks: one service and scheduler per bridge worker. The store
  // is shared by every thread's session; the scheduler only runs while this
  // worker (and therefore bb) is alive.
  let automations: AutomationService | undefined;
  let automationTimer: ReturnType<typeof setInterval> | undefined;
  const dispatching = new Set<string>();
  // Idle-time tasks: shared housekeeping timer with automations; credentials
  // come from a dedicated account host bound to the enabling session's launch.
  let offpeak: OffPeakService | undefined;
  let offPeakAccount: { close(): void } | undefined;
  let offPeakCredentials:
    | (() => Promise<
        | { jwt: string; codingPlanApiKey: string; family: "zai" | "bigmodel" }
        | undefined
      >)
    | undefined;
  const offPeakDispatching = new Set<string>();
  const notify = (method: string, params: unknown) =>
    write({ jsonrpc: "2.0", method, params });
  const emit = (session: Session, deltas: ThreadDelta[]) =>
    notify("thread/delta", { threadId: session.threadId, deltas });
  const result = (id: unknown, value: unknown) =>
    write({ jsonrpc: "2.0", id, result: value });
  const error = (id: unknown, code: number, message: string, data?: unknown) =>
    write({
      jsonrpc: "2.0",
      id,
      error: { code, message, ...(data ? { data } : {}) },
    });

  function cancelTools(session: Session) {
    for (const [id, pending] of toolCalls)
      if (pending.session === session) {
        clearTimeout(pending.timer);
        toolCalls.delete(id);
        pending.resolve({
          content: [
            {
              type: "text",
              text: "ZCode session or turn ended before the bb tool returned.",
            },
          ],
          isError: true,
        });
      }
  }

  async function callTool(
    session: Session | undefined,
    tool: BbTool,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    if (!session || session.stopping || !session.timeline)
      return {
        content: [
          { type: "text", text: "No active bb turn for this tool call." },
        ],
        isError: true,
      };
    const id = `zcode-tool-${randomUUID()}`;
    const key = { providerItemId: id };
    const item = { type: "tool" as const, tool: tool.name, server: "bb", args };
    const presentation = tool.presentation ?? toolPresentation(tool.name);
    emit(session, [{ kind: "item.open", key, item, presentation }]);
    const response = await new Promise<ToolResult>((resolve) => {
      const timer = setTimeout(() => {
        const pending = toolCalls.get(id);
        toolCalls.delete(id);
        pending?.resolve({
          content: [{ type: "text", text: "bb tool call timed out." }],
          isError: true,
        });
      }, 10 * 60_000);
      toolCalls.set(id, {
        session,
        resolve: (response) => {
          emit(session, [
            {
              kind: "item.close",
              key,
              item: {
                ...item,
                result: response,
                ...(response.isError
                  ? { error: "bb tool reported failure." }
                  : {}),
              },
              status: response.isError ? "failed" : "completed",
              presentation,
            },
          ]);
          resolve(response);
        },
        timer,
      });
      try {
        write({
          jsonrpc: "2.0",
          id,
          method: "item/tool/call",
          params: {
            threadId: session.threadId,
            providerThreadId: session.providerThreadId,
            turnId: null,
            callId: id,
            tool: tool.name,
            arguments: args,
          },
        });
      } catch {
        clearTimeout(timer);
        const pending = toolCalls.get(id);
        toolCalls.delete(id);
        pending?.resolve({
          content: [{ type: "text", text: "Cannot forward the bb tool call." }],
          isError: true,
        });
      }
    });
    return response;
  }

  async function prepareAccount(account: AccountHost, client: ZCodeConnection) {
    try {
      await account.initialize(client);
    } catch (failure) {
      account.close();
      // An expired subscription must not hide unrelated personal API models.
      return failure instanceof Error
        ? failure.message
        : "ZCode Coding Plan is unavailable.";
    }
  }

  function settle(
    session: Session,
    status: "completed" | "failed" | "interrupted",
    response?: string,
    checkpoint?: string,
  ) {
    cancelTools(session);
    session.injectedNativeCalls.clear();
    const timeline = session.timeline;
    session.timeline = undefined;
    session.activeTurnId = undefined;
    session.compacting = false;
    timeline?.finish(status, response, checkpoint);
    for (const [id, pending] of interactions)
      if (pending.session === session) {
        clearTimeout(pending.timer);
        interactions.delete(id);
        pending.resolve({ decision: "deny" });
      }
    if (session.dispatchingOffPeakId) {
      const id = session.dispatchingOffPeakId;
      session.dispatchingOffPeakId = undefined;
      // 3102 (ticket expired) requeues for continuation; everything else is
      // a terminal outcome. Only failed turns can carry the provider code -
      // a successful reply that merely mentions 3102 must complete the task,
      // and the boundary keeps 31020-style numbers from matching.
      const expired = status !== "completed" && /\b3102\b/.test(response ?? "");
      void offpeak
        ?.completeRun(
          id,
          expired
            ? "ticketExpired"
            : status === "completed"
              ? "completed"
              : "failed",
          expired ? "execution window expired" : undefined,
        )
        .catch(() => undefined);
      // The concurrency slot guards active executions: release it only now
      // that the turn has settled.
      offPeakDispatching.delete(id);
      if (session.automationOwned && !session.stopping && !session.queue.length)
        void release(session, false, false).catch(() => undefined);
    }
    if (session.dispatchingAutomationId) {
      const id = session.dispatchingAutomationId;
      session.dispatchingAutomationId = undefined;
      void automations
        ?.completeRun(
          id,
          status === "completed",
          status === "completed" ? undefined : `Scheduled turn ${status}.`,
        )
        .catch(() => undefined);
      // The dispatcher owns sessions it constructed headlessly; release the
      // child unless the user interleaved a queued prompt. A queued turn
      // keeps the session alive for bb's normal idle lifecycle to release.
      if (session.automationOwned && !session.stopping && !session.queue.length)
        void release(session, false, false).catch(() => undefined);
    }
  }

  async function finishTurn(
    session: Session,
    status: "completed" | "failed" | "interrupted",
    payload: Message,
  ) {
    if (!session.timeline || session.draining) return;
    session.draining = true;
    try {
      // The projection keeps its pre-bind default window; prefer the bound
      // model's advertised context window (e.g. GLM-5.3's 1M tokens).
      const projected = record(session.snapshot.projection).contextWindow;
      const window =
        modelContextWindow(session.snapshot, session.contextModel) ??
        (typeof projected === "number" ? projected : null);
      emit(session, session.usage.turn(payload.usage, window));
      try {
        const snapshot = snapshotSchema.parse(
          await session.client.request(
            "session/read",
            { sessionId: session.providerThreadId },
            2000,
          ),
        );
        if (!session.stopping) {
          // CLI 0.17.0 session/read replaces catalog windows with its 200K
          // projection default. Keep the discovery metadata for known IDs;
          // creating/resuming a session refreshes the authoritative catalog.
          for (const model of snapshot.settings.model.available) {
            const discovered = session.snapshot.settings.model.available.find(
              (entry) =>
                entry.ref.providerId === model.ref.providerId &&
                entry.ref.modelId === model.ref.modelId,
            );
            if (discovered) model.contextWindow = discovered.contextWindow;
          }
          session.snapshot = snapshot;
          session.background.update(snapshot.projection);
          emit(
            session,
            session.usage.context(
              snapshot.projection,
              modelContextWindow(snapshot, session.contextModel),
            ),
          );
        }
      } catch {
        /* Usage queries must never prevent a turn from settling. */
      }
      let checkpoint: string | undefined;
      if (status === "completed" && !session.compacting) {
        try {
          checkpoint = await session.history.checkpoint(session.beforeRowId);
        } catch {
          /* Older CLIs remain usable for prompts without history controls. */
        }
      }
      if (!session.stopping)
        settle(session, status, text(payload.response), checkpoint);
    } finally {
      session.draining = false;
    }
    while (!session.stopping && !session.timeline && session.queue.length) {
      const next = session.queue.shift()!;
      try {
        await send(session, next.input, next.options, next.clientRequestId);
      } catch (failure) {
        notify("error", {
          threadId: session.threadId,
          clientRequestId: next.clientRequestId,
          message:
            failure instanceof Error ? failure.message : "Queued prompt failed",
        });
      }
    }
  }

  function notification(session: Session, frame: Frame) {
    if (session.stopping) return;
    if (session.starting) {
      if (session.buffered.length >= 4096)
        throw new Error("ZCode sent too many events before accepting input.");
      session.buffered.push(frame);
      return;
    }
    if (frame.method === "state.updated") {
      const p = record(frame.params);
      if (p.sessionId === session.providerThreadId)
        void session.background.refresh().catch(() => {});
      if (
        p.sessionId === session.providerThreadId &&
        session.compacting &&
        [
          "session_compacted",
          "session_compact_failed",
          "session_compact_cancelled",
        ].includes(text(p.reason))
      )
        void finishTurn(
          session,
          p.reason === "session_compacted"
            ? "completed"
            : p.reason === "session_compact_cancelled"
              ? "interrupted"
              : "failed",
          {},
        );
      return;
    }
    if (frame.method !== "session/event") return;
    const event = eventSchema.parse(frame.params);
    if (event.sessionId !== session.providerThreadId) return;
    const seq = event.eventSeq ?? event.seq;
    if (seq !== undefined) {
      if (seq <= session.lastSeq) return;
      session.lastSeq = seq;
    }
    const payload = record(event.payload);
    if (event.type === "turn.started") session.activeTurnId = event.turnId;
    if (event.type === "turn.started" && !session.restorable) {
      session.restorable = true;
      notify("thread/identity", {
        threadId: session.threadId,
        providerThreadId: session.providerThreadId,
        sessionRestorable: true,
      });
    }
    if (event.type === "turn.started" && !session.timeline) {
      session.timeline = new Timeline(
        (deltas) => emit(session, deltas),
        session.cwd,
      );
      emit(session, [
        {
          kind: "turn.open",
        },
      ]);
    }
    if (["session.updated", "tool.updated"].includes(event.type))
      void session.background.refresh().catch(() => {});
    if (!session.timeline) return;
    if (event.type === "turn.completed") {
      const status =
        payload.resultType === "cancelled"
          ? "interrupted"
          : payload.resultType === "success"
            ? "completed"
            : "failed";
      void finishTurn(session, status, payload);
    } else if (event.type === "turn.failed") {
      void finishTurn(session, "failed", {
        response: `ZCode: ${text(record(payload.error).message, "Turn failed.")}`,
      });
    } else {
      if (event.type === "tool.updated") {
        const id = text(payload.toolCallId);
        if (session.toolServer?.nativeNames.has(text(payload.toolName)))
          session.injectedNativeCalls.add(id);
        if (session.injectedNativeCalls.has(id)) return;
      }
      session.timeline.event(event.type, event.payload);
    }
  }

  function ask(session: Session, payload: unknown): Promise<unknown> {
    const parsed =
      record(payload).kind === "approval"
        ? approvalInteractionOutcomeSchema.shape.payload.parse(payload)
        : interactionRequestPayloadSchema.parse(payload);
    const id = `zcode-interaction-${randomUUID()}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        interactions.delete(id);
        resolve({ decision: "deny" });
      }, 10 * 60_000);
      interactions.set(id, { session, resolve, timer });
      write({
        jsonrpc: "2.0",
        id,
        method: "interaction/request",
        params: {
          threadId: session.threadId,
          providerThreadId: session.providerThreadId,
          turnId: null,
          providerNativeIds: true,
          payload: parsed,
        },
      });
    });
  }

  async function reverseRequest(
    session: Session | undefined,
    method: string,
    raw: unknown,
    context?: {
      account: AccountHost;
      cwd: string;
      preferences: typeof RUNTIME_PREFERENCES;
      subagents?: Subagents;
      nativeSessionId?: string;
    },
  ): Promise<unknown> {
    if (method === "session/requestRuntimePreferences")
      return context?.preferences ?? RUNTIME_PREFERENCES;
    if (method === "subagents/readRuntimeConfig") {
      // Native asks during session/create, before its generated identity is
      // returned. Each supervised child owns exactly one session: bind its
      // first startup callback, then require the same identity thereafter.
      if (
        !session &&
        context?.subagents &&
        !context.nativeSessionId &&
        typeof record(raw).sessionId === "string"
      )
        context.nativeSessionId = String(record(raw).sessionId);
      const expected = session?.providerThreadId ?? context?.nativeSessionId;
      if (
        closed ||
        session?.stopping ||
        !expected ||
        record(raw).sessionId !== expected
      )
        throw new ProtocolError("ZCode session mismatch.", -32602);
      return context?.subagents ?? { kind: "built-in-fallback" };
    }
    if (method === "interaction/requestOfficialMcpAuthHeaders") {
      if (session?.stopping || !context?.account.authorizeOfficialMcp)
        return { ok: false, reason: "official_auth_unavailable" };
      return context.account.authorizeOfficialMcp(raw, context.cwd);
    }
    if (method === "interaction/requestProviderRuntimeHeaders") {
      if (session && !session.stopping)
        return session.account.authorize(raw, session.providerThreadId);
      return {
        headersApplied: false,
        errorMessage: "No active bb session for ZCode account authentication.",
      };
    }
    if (AUTOMATION_METHODS.has(method)) {
      if (!automations)
        throw new ProtocolError(
          "ZCode automations are disabled. Enable the plugin's automations setting, or use ZCode Desktop for this feature.",
          -32601,
        );
      return automations.handle(method, raw, {
        threadId: session?.threadId,
        providerThreadId: session?.providerThreadId,
        cwd: session?.cwd,
        providerOptions: session?.providerOptions,
      });
    }
    if (OFF_PEAK_METHODS.has(method)) {
      if (!offpeak)
        throw new ProtocolError(
          "ZCode idle-time tasks are disabled. Enable the plugin's idle-time tasks setting, or use ZCode Desktop for this feature.",
          -32601,
        );
      return offpeak.handle(method, raw, {
        threadId: session?.threadId,
        providerThreadId: session?.providerThreadId,
        cwd: session?.cwd,
        providerOptions: session?.providerOptions,
      });
    }
    // These native ports need a host service bb's provider bridge does not
    // expose (verified against SDK 0.6.49: BRIDGE_REQUEST_METHODS has no
    // host-service channel). Reject uniformly with an actionable reason
    // instead of a generic capability error or a session mismatch.
    const hostService = hostServiceUnavailable(method);
    if (hostService)
      throw new ProtocolError(
        `${hostService} is not available through bb's provider bridge. Use ZCode Desktop for this feature.`,
        -32601,
      );
    if (!session || session.stopping)
      throw new ProtocolError("No active bb session for this request.", -32601);
    const p = record(raw);
    if (p.sessionId !== session.providerThreadId)
      throw new ProtocolError("ZCode session mismatch.", -32602);
    if (method === "interaction/requestPermission") {
      const options = z
        .array(
          z
            .object({
              response: z.object({ decision: z.string() }).passthrough(),
            })
            .passthrough(),
        )
        .parse(p.options);
      if (!options.some((option) => option.response.decision === "allow"))
        return {
          decision: "deny",
          reason: "No single-use allow option was supplied.",
        };
      const tool = text(p.toolName, "ZCode tool");
      const itemId = text(p.toolCallId);
      if (!itemId) throw new ProtocolError("Missing tool call id.", -32602);
      const input = record(p.input);
      const subject =
        tool === "Bash" && typeof input.command === "string"
          ? {
              kind: "command",
              itemId,
              command: input.command,
              cwd: session.cwd,
              actions: [],
              sessionGrant: null,
            }
          : ["Write", "Edit", "MultiEdit"].includes(tool)
            ? {
                kind: "file_change",
                itemId,
                writeScope: null,
                sessionGrant: null,
              }
            : {
                kind: "tool_use",
                itemId,
                tool,
                presentation: toolPresentation(tool, text(p.reason)),
              };
      const answer = record(
        await ask(session, {
          kind: "approval",
          subject,
          reason: text(p.reason) || null,
          availableDecisions: ["allow_once", "deny"],
        }),
      );
      return { decision: answer.decision === "allow_once" ? "allow" : "deny" };
    }
    if (method === "interaction/requestUserInput") {
      const questions =
        Array.isArray(p.questions) && p.questions.length
          ? p.questions.map(record)
          : [
              {
                question: text(p.prompt, "ZCode needs your input"),
                header: "ZCode",
              },
            ];
      const answer = record(
        await ask(session, {
          kind: "user_question",
          questions: questions.map((q, i) => ({
            id: `q${i}`,
            prompt: text(q.question),
            shortLabel: text(q.header, "ZCode"),
            multiSelect: q.multiSelect === true,
            allowFreeText: true,
            options: Array.isArray(q.options)
              ? q.options.map((option) => {
                  const o = record(option);
                  return {
                    value: text(o.value),
                    label: text(o.label),
                    ...(o.description
                      ? { description: text(o.description) }
                      : {}),
                  };
                })
              : [],
          })),
        }),
      );
      if (answer.kind !== "user_answer") return { action: "cancel" };
      const answers = record(answer.answers);
      return {
        action: "accept",
        content: {
          answers: Object.fromEntries(
            questions.map((q, i) => {
              const a = record(answers[`q${i}`]);
              const values = Array.isArray(a.selected)
                ? a.selected.map((v) => text(v))
                : [];
              if (typeof a.freeText === "string") values.push(a.freeText);
              return [text(q.question), values.join(", ")];
            }),
          ),
        },
      };
    }
    throw new ProtocolError(
      `ZCode host capability is not implemented: ${method}`,
      -32601,
    );
  }

  async function release(session: Session, interrupt: boolean, ended = true) {
    session.stopping = true;
    session.queue = [];
    cancelTools(session);
    const closingTools = session.toolServer?.close();
    session.account.close();
    if (interrupt) {
      try {
        await session.background.cancelAll();
      } catch {
        /* Child shutdown also tears down owned native work. */
      }
    }
    session.background.close(interrupt ? "interrupted" : "failed");
    if (interrupt && session.timeline) {
      try {
        await session.client.request(
          "session/stop",
          { sessionId: session.providerThreadId },
          3000,
        );
      } catch {
        /* forced settlement below */
      }
    }
    settle(session, interrupt ? "interrupted" : "failed");
    await session.client.close();
    await closingTools;
    clients.delete(session.client);
    accounts.delete(session.client);
    sessions.delete(session.threadId);
    if (ended) emit(session, [{ kind: "session.ended" }]);
  }

  function ensureAutomations(): void {
    if (automations || closed) return;
    automations = createAutomationService();
    automationTimer = setInterval(
      () => void housekeepingTick(),
      config.automationTickMs ?? 30_000,
    );
    // The worker's stdio/SIGTERM handlers own its lifetime; the timer must
    // not hold the process open on shutdown.
    automationTimer.unref?.();
    void housekeepingTick();
  }

  function ensureOffPeak(launch: LaunchSpec): void {
    if (offpeak || closed) return;
    // Test factories may return stub hosts; any host exposing the
    // off-peak credential accessor can serve the gateway client.
    const account =
      config.accountFactory?.(launch) ?? new CodingPlanHost(launch);
    const host = account as {
      offPeakCredentials?(): Promise<
        | { jwt: string; codingPlanApiKey: string; family: "zai" | "bigmodel" }
        | undefined
      >;
      close(): void;
    };
    if (typeof host.offPeakCredentials !== "function") return;
    offPeakAccount = host;
    offPeakCredentials = () => host.offPeakCredentials!();
    offpeak = createOffPeakService({
      client: config.offPeakClientFactory
        ? config.offPeakClientFactory()
        : createOffPeakServerClient({
            resolveOrigin: () => "https://zcode.z.ai",
            resolveCredentials: async () => {
              const credentials = await host.offPeakCredentials!();
              if (!credentials)
                throw new Error(
                  "off-peak requires a desktop sign-in with an individual Coding Plan",
                );
              return credentials;
            },
          }),
    });
    if (!automationTimer) {
      automationTimer = setInterval(
        () => void housekeepingTick(),
        config.automationTickMs ?? 30_000,
      );
      automationTimer.unref?.();
    }
    void housekeepingTick();
  }

  async function housekeepingTick(): Promise<void> {
    if (closed) return;
    await Promise.allSettled([
      automations ? automationTick() : undefined,
      offpeak ? offPeakTick() : undefined,
    ]);
  }

  async function manageAutomationsChecked(
    session: Session,
    command: string,
    argument: string,
  ) {
    if (!automations)
      throw new ProtocolError(
        "ZCode automations are disabled. Enable the plugin's automations setting.",
        -32000,
      );
    return manageAutomations(automations, session.cwd, command, argument);
  }

  async function manageOffPeakChecked(
    session: Session,
    command: string,
    argument: string,
  ) {
    if (!offpeak)
      throw new ProtocolError(
        "ZCode idle-time tasks are disabled. Enable the plugin's idle-time tasks setting.",
        -32000,
      );
    return manageOffPeakTasks(offpeak, session.cwd, command, argument);
  }

  async function automationTick(): Promise<void> {
    if (!automations || closed) return;
    await automations.ready().catch(() => undefined);
    if (closed) return;
    const at = new Date();
    for (const entry of automations.due(at)) {
      // Bounded concurrency across threads, one run per automation.
      if (dispatching.size >= 2) break;
      if (!automations.beginRun(entry.automationId, at)) continue;
      if (automations.runOverdue(entry.automationId, at)) {
        void automations
          .completeRun(
            entry.automationId,
            false,
            "Session stayed busy for ten minutes.",
          )
          .catch(() => undefined);
        continue;
      }
      dispatching.add(entry.automationId);
      void dispatchAutomation(entry.automationId)
        .catch(() => undefined)
        .finally(() => dispatching.delete(entry.automationId));
    }
  }

  function automationOptions(entry: StoredAutomation): BridgeExecutionOptions {
    const permissionMode = dispatchPermissionMode(entry.mode);
    const shared = {
      ...(entry.mode === "plan" ? { promptMode: "plan" as const } : {}),
      ...(entry.modelSelection
        ? {
            model: `${entry.modelSelection.providerId}/${entry.modelSelection.modelId}`,
          }
        : {}),
      ...(entry.providerOptions !== undefined
        ? { providerOptions: entry.providerOptions as Record<string, unknown> }
        : {}),
    };
    return permissionMode === "full"
      ? {
          permissionMode: "full",
          permissionScope: "full",
          approvalReviewer: null,
          permissionEscalation: null,
          ...shared,
        }
      : {
          permissionMode: "accept-edits",
          permissionScope: "workspace",
          approvalReviewer: "user",
          permissionEscalation: "ask",
          ...shared,
        };
  }

  async function dispatchAutomation(id: string): Promise<void> {
    if (!automations) return;
    let entry: Awaited<ReturnType<AutomationService["find"]>>;
    try {
      entry = await automations.find(id);
    } catch {
      // An unreadable store must not strand the run reservation: retry on
      // the next tick instead of freezing the schedule until restart.
      automations.retryRun(id);
      return;
    }
    // Deleted while queued: remove() already cleared its run reservation.
    // A record without a binding cannot dispatch; release the reservation.
    if (!entry || !entry.targetTaskId) {
      automations.retryRun(id);
      return;
    }
    const at = new Date();
    const existing = sessions.get(entry.threadId);
    if (
      existing &&
      (existing.timeline ||
        existing.starting ||
        existing.stopping ||
        existing.draining ||
        existing.background.active)
    ) {
      automations.deferRun(id, at);
      return;
    }
    let session = existing;
    let owned = false;
    // A thread still constructing its session retries on the next tick
    // instead of recording a failure.
    if (
      !session &&
      (constructing.has(entry.threadId) || startingClients.has(entry.threadId))
    ) {
      automations!.retryRun(id);
      return;
    }
    try {
      if (!session) {
        // Cold-resume the bound native session with the settings snapshot
        // captured at creation; scheduled turns never manage schedules.
        session = await construct(
          {
            threadId: entry.threadId,
            cwd: entry.workspacePath,
            providerThreadId: entry.targetTaskId,
            instructionMode: "replace",
            options: automationOptions(entry),
            disallowedTools: [...CRON_TOOL_NAMES],
          },
          true,
        );
        owned = true;
        session.automationOwned = true;
        session.providerOptions = entry.providerOptions;
      }
      session.dispatchingAutomationId = id;
      await send(
        session,
        [{ type: "text", text: entry.prompt, mentions: [] }],
        automationOptions(entry),
        undefined,
        id,
      );
      // Turn completion is reported by settle() through the marker above.
    } catch (failure) {
      if (session) session.dispatchingAutomationId = undefined;
      const message =
        failure instanceof Error ? failure.message : String(failure);
      if (owned && session)
        await release(session, true, false).catch(() => undefined);
      // A turn that raced the dispatch (or a bb resume that won the thread)
      // defers instead of burning one of the three failure strikes.
      if (/ZCode is busy|already has a ZCode session/.test(message)) {
        automations.deferRun(id, new Date());
        return;
      }
      await automations.completeRun(id, false, message).catch(() => undefined);
    }
  }

  async function offPeakTick(): Promise<void> {
    if (!offpeak || closed) return;
    await offpeak.ready().catch(() => undefined);
    await offpeak.syncCycle().catch(() => undefined);
    if (closed) return;
    for (const task of offpeak.due(new Date())) {
      if (offPeakDispatching.size >= 2) break;
      if (!offpeak.beginRun(task.offPeakTaskId)) continue;
      offPeakDispatching.add(task.offPeakTaskId);
      // The slot stays held until the dispatched turn settles; every path
      // that ends without a running turn releases it explicitly inside
      // dispatchOffPeak (the service claim is released alongside).
      void dispatchOffPeak(task.offPeakTaskId).catch(() => undefined);
    }
  }

  async function dispatchOffPeak(id: string): Promise<void> {
    if (!offpeak) return;
    let task: StoredOffPeakTask | undefined;
    try {
      task = await offpeak.find(id);
    } catch {
      offpeak.retryRun(id);
      offPeakDispatching.delete(id);
      return;
    }
    if (!task || !task.serverTicketId) {
      offpeak.retryRun(id);
      offPeakDispatching.delete(id);
      return;
    }
    // Busy bound sessions defer BEFORE any mode write: a rejected send must
    // never switch the user session's permission mode (native guard).
    const existing = sessions.get(task.threadId);
    if (
      existing &&
      (existing.timeline ||
        existing.starting ||
        existing.stopping ||
        existing.draining ||
        existing.background.active)
    ) {
      await offpeak.deferRun(id).catch(() => undefined);
      offPeakDispatching.delete(id);
      return;
    }
    if (
      !existing &&
      (constructing.has(task.threadId) || startingClients.has(task.threadId))
    ) {
      offpeak.retryRun(id);
      offPeakDispatching.delete(id);
      return; // next tick claims it again
    }
    let credentials: Awaited<
      ReturnType<NonNullable<typeof offPeakCredentials>>
    >;
    try {
      credentials = (await offPeakCredentials?.())!;
    } catch (failure) {
      // A throwing credential read (e.g. sign-in decrypt failure) must not
      // strand the claim; treat it as a permanent dispatch failure.
      await offpeak
        .completeRun(
          id,
          "failed",
          `off-peak credentials unavailable: ${
            failure instanceof Error ? failure.message : String(failure)
          }`,
          { permanent: true },
        )
        .catch(() => undefined);
      offPeakDispatching.delete(id);
      return;
    }
    if (!credentials) {
      await offpeak.completeRun(
        id,
        "failed",
        "off-peak requires a desktop sign-in with an individual Coding Plan",
        { permanent: true },
      );
      offPeakDispatching.delete(id);
      return;
    }
    const idlePlanProviderId = `account:${credentials.family}-offpeak-idle-plan`;
    if (!task.model) {
      await offpeak.completeRun(
        id,
        "failed",
        "idle-time task has no model; recreate it with an explicit model",
        { permanent: true },
      );
      offPeakDispatching.delete(id);
      return;
    }
    const shared = {
      // bb policy vocabulary has no "plan" permissionMode; plan goes through
      // promptMode like everywhere else in this bridge.
      ...(task.permissionMode === "plan"
        ? { promptMode: "plan" as const }
        : {}),
      model: `${idlePlanProviderId}/${task.model}`,
      ...(task.thoughtLevel ? { reasoningLevel: task.thoughtLevel } : {}),
      ...(task.providerOptions !== undefined
        ? { providerOptions: task.providerOptions as Record<string, unknown> }
        : {}),
    };
    const options: BridgeExecutionOptions =
      task.permissionMode === "yolo"
        ? {
            permissionMode: "full",
            permissionScope: "full",
            approvalReviewer: null,
            permissionEscalation: null,
            ...shared,
          }
        : {
            permissionMode: "accept-edits",
            permissionScope: "workspace",
            approvalReviewer: "user",
            permissionEscalation: "ask",
            ...shared,
          };
    let session = existing;
    let owned = false;
    try {
      if (!session) {
        session = await construct(
          {
            threadId: task.threadId,
            cwd: task.workspacePath,
            providerThreadId: task.boundSessionId,
            instructionMode: "replace",
            options,
            disallowedTools: [...OFF_PEAK_RUN_TOOL_DENYLIST],
          },
          true,
        );
        owned = true;
        session.automationOwned = true;
        session.providerOptions = task.providerOptions;
      }
      // Persist dispatch progress before the prompt leaves. A task that was
      // cancelled while the dispatcher waited, or whose durable write
      // failed, must not receive the prompt at all.
      const running = await offpeak.markRunning(id);
      if (!running) {
        // Cancelled while dispatch waited, or the durable write failed and
        // the service rolled back: release the service claim, the child and
        // the slot, and let the next tick decide.
        offpeak.retryRun(id);
        if (owned && session)
          await release(session, true, false).catch(() => undefined);
        offPeakDispatching.delete(id);
        return;
      }
      session.dispatchingOffPeakId = id;
      const executionId = `${id}:${task.ranOnce ? "resume" : "init"}:${randomUUID()}`;
      await send(
        session,
        [
          {
            type: "text",
            text: task.ranOnce ? OFF_PEAK_CONTINUATION_PROMPT : task.prompt,
            mentions: [],
          },
        ],
        options,
        undefined,
        undefined,
        {
          offPeakTaskId: id,
          offPeakRunType: task.ranOnce ? "resume" : "init",
          modelSelection: {
            providerId: idlePlanProviderId,
            modelId: task.model,
            ...(task.thoughtLevel
              ? { options: { reasoningLevel: task.thoughtLevel } }
              : {}),
          },
          modelExecution: {
            memoryExtraction: "skip",
            selectionScope: "execution",
            offPeak: {
              executionId,
              ticketId: task.serverTicketId,
              providerErrorCode: "3102",
            },
            requestAuth: {
              apiKey: credentials.jwt,
              headers: {
                Authorization: `Bearer ${credentials.jwt}`,
                "X-Coding-Plan-Api-Key": credentials.codingPlanApiKey,
                "X-Off-Peak-Ticket-ID": task.serverTicketId,
              },
            },
            subagents: { foregroundModel: "submission", background: "allow" },
          },
        },
      );
      // The native side accepted the prompt: only now does a crash recover
      // as a continuation. If the durable admission record could not be
      // written, treat the run as failed so a restart never silently
      // replays an accepted task.
      const admitted = await offpeak.markAdmitted(id);
      if (!admitted && (await offpeak.find(id))?.status !== "cancelled") {
        if (session) session.dispatchingOffPeakId = undefined;
        await offpeak
          .completeRun(id, "failed", "admission record could not be persisted")
          .catch(() => undefined);
        if (owned && session)
          await release(session, true, false).catch(() => undefined);
        offPeakDispatching.delete(id);
      }
    } catch (failure) {
      if (session) session.dispatchingOffPeakId = undefined;
      const message =
        failure instanceof Error ? failure.message : String(failure);
      if (owned && session)
        await release(session, true, false).catch(() => undefined);
      if (/ZCode is busy|already has a ZCode session/.test(message)) {
        await offpeak.deferRun(id).catch(() => undefined);
        offPeakDispatching.delete(id);
        return;
      }
      await offpeak.completeRun(id, "failed", message).catch(() => undefined);
      offPeakDispatching.delete(id);
    }
  }

  async function construct(
    params:
      | z.infer<typeof threadStartParamsSchema>
      | z.infer<typeof threadResumeParamsSchema>,
    resume: boolean,
  ) {
    if (sessions.has(params.threadId) || constructing.has(params.threadId))
      throw new ProtocolError("Thread already has a ZCode session.", -32602);
    constructing.add(params.threadId);
    let session: Session | undefined;
    let client: ZCodeConnection | undefined;
    let account: AccountHost | undefined;
    let toolServer: ToolServer = undefined;
    try {
      const launch = resolveLaunch(params.options.providerOptions, {
        ...(config.env ?? process.env),
        ...params.options.envVars,
      });
      account = config.accountFactory?.(launch) ?? new CodingPlanHost(launch);
      const settings = runtimeSettings(params.options.providerOptions);
      if (settings.mcpServers.some((s) => s.name === "bb-bridge"))
        throw new ProtocolError(
          "MCP server name bb-bridge is reserved for bb tools.",
          -32602,
        );
      toolServer = await createToolServer(
        settings.bbToolsEnabled ? (params.dynamicTools ?? []) : [],
        params.disallowedTools ?? [],
        (tool, args) => callTool(session, tool, args),
      );
      const mcpServers = [
        ...settings.mcpServers,
        ...(toolServer ? [toolServer.definition] : []),
      ];
      const context = {
        account,
        cwd: params.cwd,
        preferences: settings.preferences,
        subagents: settings.subagents,
        nativeSessionId: resume
          ? (params as z.infer<typeof threadResumeParamsSchema>)
              .providerThreadId
          : (undefined as string | undefined),
      };
      client = factory(
        launch,
        params.cwd,
        {
          notification: (frame) => {
            if (session) notification(session, frame);
          },
          request: (method, raw) =>
            reverseRequest(session, method, raw, context),
          exit: (failure) => {
            account?.close();
            if (session && !session.stopping) {
              session.stopping = true;
              session.queue = [];
              cancelTools(session);
              void toolServer?.close();
              session.background.close("failed");
              settle(session, "failed", failure.message);
              sessions.delete(session.threadId);
              emit(session, [{ kind: "session.ended" }]);
            }
            if (client) {
              clients.delete(client);
              accounts.delete(client);
            }
          },
        },
        params.threadId,
      );
      clients.add(client);
      accounts.set(client, account);
      startingClients.set(params.threadId, client);
      const accountError = await prepareAccount(account, client);
      const mode = modeFor(params.options);
      if (settings.automationsEnabled) ensureAutomations();
      if (settings.offPeakTasksEnabled) ensureOffPeak(launch);
      // With automations off the native cron tools stay hidden instead of
      // erroring at call time; with them on, the bridge answers the ports.
      const disallowedTools = [
        ...(params.disallowedTools ?? []),
        ...(settings.automationsEnabled ? [] : CRON_TOOL_NAMES),
      ];
      const response = await client.request(
        resume ? "session/resume" : "session/create",
        {
          // Discover native reasoning defaults before binding a model on session/send.
          ...(resume
            ? {
                sessionId: (params as z.infer<typeof threadResumeParamsSchema>)
                  .providerThreadId,
              }
            : {
                mode,
                persistence: "immediate",
                titleGenerationEnabled: false,
              }),
          workspace: workspaceRef(params.cwd),
          ...(mcpServers.length ? { mcpServers } : {}),
          ...(disallowedTools.length ? { toolDenylist: disallowedTools } : {}),
          // Idle-time tools register only when the host implements the ports.
          ...(settings.offPeakTasksEnabled ? { offPeakToolEnabled: true } : {}),
        },
      );
      const snapshot = snapshotSchema.parse(response);
      if (
        context.nativeSessionId &&
        context.nativeSessionId !== snapshot.session.sessionId
      )
        throw new ProtocolError("ZCode startup session mismatch.", -32602);
      context.nativeSessionId = snapshot.session.sessionId;
      if (
        accountError &&
        !snapshot.settings.model.available.some(
          (model) => !model.disabledReason,
        )
      )
        throw new Error(accountError);
      if (closed) throw new Error("Bridge is closed.");
      if (
        resume &&
        snapshot.session.sessionId !==
          (params as z.infer<typeof threadResumeParamsSchema>).providerThreadId
      )
        throw new Error("ZCode resumed a different session.");
      let restoredUsage: unknown;
      if (resume) {
        try {
          restoredUsage = await client.request(
            "session/usage",
            { sessionId: snapshot.session.sessionId },
            2000,
          );
        } catch {
          /* Older native runtimes may not expose persisted usage. */
        }
      }
      session = {
        threadId: params.threadId,
        providerThreadId: snapshot.session.sessionId,
        client,
        account,
        accountError,
        cwd: params.cwd,
        providerOptions: params.options.providerOptions,
        mode,
        starting: false,
        buffered: [],
        stopping: false,
        lastSeq: -1,
        snapshot,
        usage: new Usage(restoredUsage),
        contextModel:
          selectedModel(params.options.model) ??
          snapshot.settings.model.current,
        queue: [],
        accepted: new Set(),
        compacting: false,
        draining: false,
        toolServer,
        skills,
        injectedNativeCalls: new Set(),
        history: new History(client, snapshot.session.sessionId),
        background: new BackgroundWork(
          client,
          snapshot.session.sessionId,
          (deltas) => {
            if (session) emit(session, deltas);
          },
        ),
        beforeRowId: -1,
        restorable: resume || (snapshot.projection?.turnCount ?? 0) > 0,
        instructions:
          !resume || snapshot.projection?.turnCount === 0
            ? params.options.instructions
            : undefined,
      };
      if (resume)
        await client.request("session/setMode", {
          sessionId: session.providerThreadId,
          mode,
        });
      await client.request("session/subscribe", {
        sessionId: session.providerThreadId,
        deliveryKind: "desktop-continuous",
        includeSnapshot: false,
      });
      sessions.set(params.threadId, session);
      notify("thread/identity", {
        threadId: params.threadId,
        providerThreadId: session.providerThreadId,
        sessionRestorable: session.restorable,
      });
      emit(session, [
        { kind: "session.reset" },
        {
          kind: "extension.state",
          extensionKind: "bb/provider-commands",
          payload: { commands: managementCommands },
        },
      ]);
      session.background.update(snapshot.projection);
      // Size the context meter from model metadata before the first turn:
      // the native projection still carries its pre-bind default window.
      // bb's selected model (budget variants included) wins over the native
      // current model when reporting the window.
      emit(
        session,
        session.usage.context(
          snapshot.projection,
          modelContextWindow(snapshot, session.contextModel),
        ),
      );
      return session;
    } catch (failure) {
      await toolServer?.close();
      account?.close();
      if (client) {
        await client.close();
        clients.delete(client);
        accounts.delete(client);
      }
      throw failure;
    } finally {
      constructing.delete(params.threadId);
      startingClients.delete(params.threadId);
    }
  }

  async function send(
    session: Session,
    input: PromptInput[],
    options: BridgeExecutionOptions,
    clientRequestId?: string,
    automationId?: string,
    offPeakExecution?: {
      modelSelection: Record<string, unknown>;
      modelExecution: Record<string, unknown>;
      offPeakTaskId: string;
      offPeakRunType: "init" | "resume";
    },
  ) {
    if (
      session.timeline ||
      session.starting ||
      session.stopping ||
      session.draining
    )
      throw new ProtocolError(
        "ZCode is busy. Wait for the turn to finish or stop it.",
        -32000,
      );
    session.starting = true;
    try {
      const material = await nativeInput(input, session.cwd);
      const prompt = material.content;
      const command =
        !material.attachments &&
        /^\/(zcode-tasks|zcode-task-output|zcode-task-stop|zcode-file-preview|zcode-file-rewind|zcode-check|zcode-plugin|zcode-automations|zcode-automation-delete|zcode-offpeak|zcode-offpeak-cancel)(?:\s+(.*))?$/.exec(
          prompt.trim(),
        );
      if (command) {
        const argument = (command[2] ?? "").trim();
        if (
          command[1] === "zcode-file-rewind" &&
          (options.permissionMode !== "full" || options.promptMode === "plan")
        )
          throw new ProtocolError(
            "File rewind requires bb Full Access outside plan mode.",
            -32000,
          );
        if (command[1] === "zcode-file-rewind")
          await session.background.refresh();
        if (command[1] === "zcode-file-rewind" && session.background.active)
          throw new ProtocolError(
            "Stop background tasks before rewinding workspace files.",
            -32000,
          );
        const response =
          command[1] === "zcode-file-preview"
            ? await session.history.previewFiles(argument || undefined)
            : command[1] === "zcode-file-rewind"
              ? await session.history.rewindFiles(argument)
              : command[1] === "zcode-check"
                ? await checkConnectivity(session, argument)
                : command[1] === "zcode-plugin"
                  ? await managePlugins(session, argument)
                  : command[1] === "zcode-automations" ||
                      command[1] === "zcode-automation-delete"
                    ? await manageAutomationsChecked(
                        session,
                        command[1],
                        argument,
                      )
                    : command[1] === "zcode-offpeak" ||
                        command[1] === "zcode-offpeak-cancel"
                      ? await manageOffPeakChecked(
                          session,
                          command[1],
                          argument,
                        )
                      : await session.background.manage(command[1]!, argument);
        if (session.stopping)
          throw new Error("Session stopped while managing tasks.");
        if (clientRequestId) session.accepted.add(clientRequestId);
        emit(session, [
          ...(clientRequestId
            ? [{ kind: "input.accepted" as const, clientRequestId }]
            : []),
          { kind: "turn.open" },
        ]);
        new Timeline((deltas) => emit(session, deltas), session.cwd).finish(
          "completed",
          response,
        );
        session.starting = false;
        for (const frame of session.buffered.splice(0))
          notification(session, frame);
        return;
      }
      const compact = !material.attachments && prompt.trim() === "/compact";
      session.beforeRowId = Number.MAX_SAFE_INTEGER;
      if (!compact) {
        try {
          const range = await session.history.rows();
          session.beforeRowId = range.rows.at(-1)?.rowId ?? -1;
        } catch {
          /* Optional controls are negotiated independently of prompting. */
        }
      }
      const mode = modeFor(options);
      if (mode !== session.mode) {
        await session.client.request("session/setMode", {
          sessionId: session.providerThreadId,
          mode,
        });
        session.mode = mode;
      }
      const modelSelection = modelForTurn(
        session.snapshot,
        options.model,
        options.reasoningLevel,
      );
      // Keep the last accepted bb selection across native background turns.
      // Only modelSelection crosses the native boundary, with its real ID.
      const rawSelection =
        selectedModel(options.model) ?? session.snapshot.settings.model.current;
      if (
        session.accountError &&
        modelSelection?.providerId.startsWith("account:")
      )
        throw new Error(session.accountError);
      const response = record(
        await session.client.request(
          compact ? "session/compact" : "session/send",
          {
            sessionId: session.providerThreadId,
            inputId: clientRequestId ?? randomUUID(),
            ...(!compact
              ? {
                  content:
                    (session.skills ?? "") +
                    (session.instructions
                      ? `<bb_instructions>\n${session.instructions}\n</bb_instructions>\n\n${prompt}`
                      : prompt),
                  ...(material.attachments
                    ? { attachments: material.attachments }
                    : {}),
                  ...(modelSelection ? { modelSelection } : {}),
                  ...(automationId ? { automationId } : {}),
                  ...(offPeakExecution
                    ? {
                        toolDenylist: [...OFF_PEAK_RUN_TOOL_DENYLIST],
                        modelSelection: offPeakExecution.modelSelection,
                        modelExecution: offPeakExecution.modelExecution,
                        offPeakTaskId: offPeakExecution.offPeakTaskId,
                        offPeakRunType: offPeakExecution.offPeakRunType,
                      }
                    : {}),
                }
              : {}),
          },
        ),
      );
      if (
        compact
          ? record(response.compact).state !== "accepted"
          : response.accepted !== true
      )
        throw new Error("ZCode did not accept the prompt.");
      session.contextModel = rawSelection
        ? {
            providerId: rawSelection.providerId,
            modelId: rawSelection.modelId,
          }
        : undefined;

      if (!compact) session.skills = undefined;
      if (session.stopping)
        throw new Error("Session stopped while submitting the prompt.");
      session.instructions = undefined;
      if (clientRequestId) {
        session.accepted.add(clientRequestId);
        if (session.accepted.size > 1024)
          session.accepted.delete(session.accepted.values().next().value!);
      }
      session.compacting = compact;
      session.timeline = new Timeline(
        (deltas) => emit(session, deltas),
        session.cwd,
      );
      const started = session.buffered.find(
        (frame) => record(frame.params).type === "turn.started",
      );
      session.activeTurnId = text(record(started?.params).turnId) || undefined;
      emit(session, [
        ...(clientRequestId
          ? [{ kind: "input.accepted" as const, clientRequestId }]
          : []),
        { kind: "turn.open" },
      ]);
      session.starting = false;
      for (const frame of session.buffered.splice(0))
        notification(session, frame);
    } catch (failure) {
      session.starting = false;
      session.buffered = [];
      throw failure;
    }
  }

  async function forkNative(params: z.infer<typeof threadForkParamsSchema>) {
    const live = [...sessions.values()].find(
      (s) => s.providerThreadId === params.sourceProviderThreadId,
    );
    if (live) {
      if (live.stopping)
        throw new ProtocolError("Fork source is stopping.", -32602);
      if (
        !params.sourceProviderCheckpointId &&
        (live.timeline || live.starting || live.draining)
      )
        throw new ProtocolError(
          "Wait for the active ZCode turn before forking its tip.",
          -32000,
        );
      return live.history.fork(params.sourceProviderCheckpointId);
    }
    // Cold sources need a temporary supervised process; the child is resumed
    // separately with its own bb tools, credentials broker and native stream.
    const launch = resolveLaunch(params.options.providerOptions, {
      ...(config.env ?? process.env),
      ...params.options.envVars,
    });
    const account =
      config.accountFactory?.(launch) ?? new CodingPlanHost(launch);
    const settings = runtimeSettings(params.options.providerOptions);
    const context = {
      account,
      cwd: params.cwd,
      preferences: settings.preferences,
      subagents: settings.subagents,
      nativeSessionId: params.sourceProviderThreadId,
    };
    const client = factory(
      launch,
      params.cwd,
      {
        notification() {},
        request: (method, raw) =>
          reverseRequest(undefined, method, raw, context),
        exit() {
          account.close();
        },
      },
      null,
    );
    clients.add(client);
    accounts.set(client, account);
    startingClients.set(params.threadId, client);
    try {
      await prepareAccount(account, client);
      const snapshot = snapshotSchema.parse(
        await client.request("session/resume", {
          sessionId: params.sourceProviderThreadId,
        }),
      );
      if (
        snapshot.session.sessionId !== params.sourceProviderThreadId ||
        closed
      )
        throw new Error("ZCode fork source is unavailable.");
      return await new History(client, params.sourceProviderThreadId).fork(
        params.sourceProviderCheckpointId,
      );
    } finally {
      account.close();
      await client.close();
      clients.delete(client);
      accounts.delete(client);
      startingClients.delete(params.threadId);
    }
  }

  async function probe(raw: Message, cwd = homedir()) {
    const launch = resolveLaunch(
      raw.providerOptions,
      config.env ?? process.env,
    );
    const account =
      config.accountFactory?.(launch) ?? new CodingPlanHost(launch);
    const settings = runtimeSettings(raw.providerOptions);
    const context = {
      account,
      cwd,
      preferences: settings.preferences,
      subagents: settings.subagents,
      nativeSessionId: undefined as string | undefined,
    };
    const client = factory(
      launch,
      cwd,
      {
        notification() {},
        request: (method, params) =>
          reverseRequest(undefined, method, params, context),
        exit() {
          account.close();
        },
      },
      null,
    );
    clients.add(client);
    accounts.set(client, account);
    try {
      const accountError = await prepareAccount(account, client);
      const snapshot = snapshotSchema.parse(
        await client.request("session/create", {
          workspace: workspaceRef(cwd),
          mode: "build",
          persistence: "deferred",
          titleGenerationEnabled: false,
          ...(settings.mcpServers.length
            ? { mcpServers: settings.mcpServers }
            : {}),
        }),
      );
      if (
        context.nativeSessionId &&
        context.nativeSessionId !== snapshot.session.sessionId
      )
        throw new ProtocolError("ZCode startup session mismatch.", -32602);
      if (
        accountError &&
        !snapshot.settings.model.available.some(
          (model) => !model.disabledReason,
        )
      )
        throw new Error(accountError);
      return { snapshot, planLabel: account.planLabel ?? null };
    } finally {
      account.close();
      await client.close();
      clients.delete(client);
      accounts.delete(client);
    }
  }

  async function dispatch(id: unknown, method: string, raw: unknown) {
    const schema = schemas[method];
    if (!schema) {
      error(id, -32601, `Unknown method: ${method}`);
      return;
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      error(id, -32602, `Invalid params for ${method}`);
      return;
    }
    if (closed) throw new Error("Bridge is closed.");
    if (method === "initialize") {
      result(id, {
        protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
        capabilities: {
          grammarVersions: [3, 3],
          sessionRestore: true,
          threadArchive: true,
          threadRename: true,
          threadGoalClear: true,
          fork: "checkpoint",
          approvalEnforcedBy: "runtime",
          steerMode: "queue",
          skills: { configure: true },
        },
      });
      return;
    }
    if (method === "skills/configure") {
      skills = skillCatalog(parsed.data);
      result(id, {});
      return;
    }
    if (method === "model/list" || method === "provider/health") {
      const p = record(parsed.data);
      try {
        const { snapshot } = await probe(p, text(p.cwd) || homedir());
        const available = snapshot.settings.model.available.filter(
          (model) => !model.disabledReason,
        );
        if (method === "model/list") {
          const current = snapshot.settings.model.current;
          const currentId = current
            ? `${current.providerId}/${current.modelId}`
            : undefined;
          const defaultId = available.some(
            (model) =>
              `${model.ref.providerId}/${model.ref.modelId}` === currentId,
          )
            ? currentId
            : available[0]
              ? `${available[0].ref.providerId}/${available[0].ref.modelId}`
              : undefined;
          const budgetVariants = contextBudgetVariants(snapshot);
          result(id, {
            models: available.length
              ? available.flatMap((model) => {
                  const key = `${model.ref.providerId}/${model.ref.modelId}`;
                  // bb's model entries cannot carry a numeric context
                  // window; advertise GLM-5.3's 1M tokens in the description.
                  const window = model.contextWindow;
                  const budget = window
                    ? `${formatContextWindow(window)} token context window`
                    : undefined;
                  const description = model.description
                    ? [model.description, budget].filter(Boolean).join(". ")
                    : (budget ?? "");
                  const efforts = (model.reasoning?.levels ?? []).map(
                    (level) => ({
                      reasoningEffort: level.value,
                      label: level.label,
                      description: level.description ?? "",
                    }),
                  );
                  const defaultEffort =
                    model.reasoning?.defaultLevel ??
                    model.reasoning?.levels[0]?.value ??
                    "none";
                  // Models with a larger native window also get plugin-side
                  // budget variants (e.g. GLM-5.3 (256K)) that run the base
                  // model but cap the window reported to bb. The native
                  // registry has no separate ids for smaller windows.
                  const variants = budgetVariants
                    .filter(
                      (variant) =>
                        variant.base.providerId === model.ref.providerId &&
                        variant.base.modelId === model.ref.modelId &&
                        (window ?? 0) > variant.window,
                    )
                    .map((variant) => ({
                      id: `${variant.ref.providerId}/${variant.ref.modelId}`,
                      model: `${variant.ref.providerId}/${variant.ref.modelId}`,
                      displayName: `${model.label} (${formatContextWindow(variant.window)})`,
                      isDefault: false,
                      description: `${formatContextWindow(variant.window)} token context budget: caps the window reported to bb, while the model keeps its ${formatContextWindow(window!)} native window.`,
                      supportedReasoningEfforts: efforts,
                      defaultReasoningEffort: defaultEffort,
                    }));
                  const split = variants.length > 0 && window !== undefined;
                  return [
                    {
                      id: key,
                      model: key,
                      displayName: split
                        ? `${model.label} (${formatContextWindow(window!)})`
                        : model.label,
                      isDefault: key === defaultId,
                      description,
                      supportedReasoningEfforts: efforts,
                      defaultReasoningEffort: defaultEffort,
                    },
                    ...variants,
                  ];
                })
              : [DEFAULT_MODEL],
            selectedOnlyModels: [],
          });
        } else
          result(id, {
            supported: true,
            health: {
              status: available.length ? "ready" : "unauthenticated",
              statusMessage: available.length
                ? "ZCode protocol responds. Use /zcode-check in an idle session to test model connectivity."
                : "ZCode responds; configure a personal API provider to run prompts.",
              accountEmail: null,
              planLabel: null,
              installedVersion: null,
              minimumSupportedVersion: null,
              canInstall: false,
              canUpdate: false,
              loginCommand: null,
            },
          });
      } catch (failure) {
        if (method === "model/list") throw failure;
        result(id, {
          supported: true,
          health: {
            status: "unknown",
            statusMessage:
              failure instanceof Error ? failure.message : "ZCode probe failed",
            accountEmail: null,
            planLabel: null,
            installedVersion: null,
            minimumSupportedVersion: null,
            canInstall: false,
            canUpdate: false,
            loginCommand: null,
          },
        });
      }
      return;
    }
    if (method === "provider/usage") {
      const p = record(parsed.data);
      try {
        const { snapshot, planLabel } = await probe(
          p,
          text(p.cwd) || homedir(),
        );
        const available = snapshot.settings.model.available.filter(
          (model) => !model.disabledReason,
        );
        result(id, {
          supported: true,
          usage: available.length
            ? { status: "ok", accountEmail: null, planLabel, windows: [] }
            : { status: "unauthenticated" },
        });
      } catch (failure) {
        result(id, {
          supported: true,
          usage: {
            status: "error",
            message:
              failure instanceof Error ? failure.message : "ZCode probe failed",
            accountEmail: null,
            planLabel: null,
          },
        });
      }
      return;
    }
    if (
      method === "thread/archive" ||
      method === "thread/unarchive" ||
      method === "thread/name/set"
    ) {
      // bb owns thread labels and archive state; native title generation stays
      // off, so nothing native is mirrored or overwritten here.
      result(id, {});
      return;
    }
    if (method === "thread/goal/clear") {
      const params = parsed.data as z.infer<typeof threadGoalClearParamsSchema>;
      const session = sessions.get(params.threadId);
      if (!session || session.providerThreadId !== params.providerThreadId)
        throw new ProtocolError(
          "Goal clearing needs the thread's active ZCode session; resume it first.",
          -32602,
        );
      if (session.starting || session.stopping || session.draining)
        throw new ProtocolError(
          "ZCode is busy. Wait for the turn to finish or stop it.",
          -32000,
        );
      await session.client.request("session/goal", {
        sessionId: session.providerThreadId,
        action: "clear",
      });
      result(id, {});
      return;
    }
    if (method === "thread/fork") {
      const params = parsed.data as z.infer<typeof threadForkParamsSchema>;
      if (constructing.has(params.threadId))
        throw new ProtocolError(
          "Thread is already constructing a ZCode session.",
          -32602,
        );
      const previous = sessions.get(params.threadId);
      if (previous) {
        await previous.background.refresh();
        if (
          previous.timeline ||
          previous.starting ||
          previous.stopping ||
          previous.draining ||
          previous.background.active
        )
          throw new ProtocolError(
            "Cannot replace an active ZCode session; stop it first.",
            -32000,
          );
        previous.starting = true;
      }
      constructing.add(params.threadId);
      let nativeId: string;
      try {
        nativeId = await forkNative(params);
        // bb's edit-message commit forks the prepared native tip into the
        // original bb thread. Replace only its idle runtime; keep old history.
        if (previous) await release(previous, false, false);
      } catch (failure) {
        if (previous && !previous.stopping) {
          previous.starting = false;
          for (const frame of previous.buffered.splice(0))
            notification(previous, frame);
        }
        throw failure;
      } finally {
        constructing.delete(params.threadId);
      }
      const session = await construct(
        { ...params, providerThreadId: nativeId },
        true,
      );
      result(id, {
        providerThreadId: session.providerThreadId,
        sessionRestorable: true,
      });
      return;
    }
    if (method === "thread/start" || method === "thread/resume") {
      const params = parsed.data as z.infer<typeof threadStartParamsSchema>;
      if (method === "thread/resume") {
        const previous = sessions.get(params.threadId);
        if (previous) {
          await previous.background.refresh();
          if (
            previous.timeline ||
            previous.starting ||
            previous.stopping ||
            previous.draining ||
            previous.background.active
          )
            throw new ProtocolError(
              "Cannot replace an active ZCode session; stop it first.",
              -32000,
            );
          // bb commits a prepared rewind by rebinding the original bb thread
          // to the fork ID. Rebuild its process/tool endpoint without ending
          // that bb session or mutating the original persisted conversation.
          await release(previous, false, false);
        }
      }
      const session = await construct(params, method === "thread/resume");
      result(id, {
        providerThreadId: session.providerThreadId,
        sessionRestorable: session.restorable,
      });
      if (params.input?.length) {
        try {
          await send(session, params.input, params.options);
        } catch (failure) {
          notify("error", {
            threadId: session.threadId,
            message:
              failure instanceof Error
                ? failure.message
                : "Initial prompt failed",
          });
        }
      }
      return;
    }
    const p = parsed.data as z.infer<typeof turnStartParamsSchema>;
    const session = sessions.get(p.threadId);
    if (!session) {
      if (method === "thread/stop" || method === "thread/discard") {
        const starting = startingClients.get(p.threadId);
        if (starting) {
          accounts.get(starting)?.close();
          await starting.close();
          clients.delete(starting);
        }
        result(id, {});
        return;
      }
      throw new ProtocolError(
        "No ZCode session; start or resume the thread first.",
        -32602,
      );
    }
    if (p.providerThreadId !== session.providerThreadId)
      throw new ProtocolError("Provider session id mismatch.", -32602);
    if (
      (method === "turn/start" || method === "turn/steer") &&
      p.clientRequestId &&
      session.accepted.has(p.clientRequestId)
    ) {
      result(id, {});
      return;
    }
    if (method === "thread/stop" || method === "thread/discard") {
      const interrupt =
        method === "thread/discard" ||
        record(parsed.data).intent === "interrupt";
      if (!interrupt) await session.background.refresh();
      if (
        !interrupt &&
        (session.timeline || session.starting || session.background.active)
      )
        throw new ProtocolError(
          "Cannot release an active session; interrupt it first.",
          -32602,
        );
      await release(session, interrupt);
      result(id, {});
    } else if (method === "turn/steer") {
      const steer = parsed.data as z.infer<typeof turnSteerParamsSchema>;
      // bb validates expectedTurnId before dispatch. This bridge uses assembler-
      // owned turn IDs, so only the no-active-turn race can be checked here.
      if (!session.timeline && !session.starting) {
        const message = "The turn targeted by this follow-up has ended.";
        error(id, -32000, message, {
          recovery: { kind: "staleTurn", message, retryable: false },
        });
        return;
      }
      if (session.queue.length >= 32)
        throw new ProtocolError("The ZCode follow-up queue is full.", -32000);
      if (
        !session.queue.some((q) => q.clientRequestId === steer.clientRequestId)
      )
        session.queue.push(steer);
      result(id, {});
    } else {
      await send(session, p.input, p.options, p.clientRequestId);
      result(id, {});
    }
  }

  function handleLine(line: string) {
    let frame: Message;
    try {
      frame = record(JSON.parse(line));
    } catch {
      return;
    }
    if (frame.method === undefined) {
      const id = String(frame.id);
      const toolCall = toolCalls.get(id);
      if (toolCall) {
        clearTimeout(toolCall.timer);
        toolCalls.delete(id);
        const decoded = frame.error
          ? {
              contentBlocks: [
                { type: "text" as const, text: "bb tool call failed." },
              ],
              isError: true,
            }
          : decodeToolCallResponsePayload(frame.result);
        toolCall.resolve({
          content: decoded.contentBlocks,
          isError: decoded.isError,
        });
        return;
      }
      const pending = interactions.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        interactions.delete(id);
        pending.resolve(frame.error ? { decision: "deny" } : frame.result);
      }
      return;
    }
    if (typeof frame.id !== "string" && typeof frame.id !== "number") return;
    if (frame.jsonrpc !== "2.0" || typeof frame.method !== "string") {
      error(frame.id, -32602, "Invalid JSON-RPC request.");
      return;
    }
    void dispatch(frame.id, frame.method, frame.params).catch((failure) =>
      error(
        frame.id,
        failure instanceof ProtocolError ? failure.code : -32603,
        failure instanceof Error ? failure.message : "ZCode bridge failed",
      ),
    );
  }
  async function close() {
    closed = true;
    if (automationTimer) clearInterval(automationTimer);
    offPeakAccount?.close();
    for (const account of accounts.values()) account.close();
    await Promise.allSettled(
      [...sessions.values()].map((session) => release(session, true)),
    );
    await Promise.allSettled([...clients].map((client) => client.close()));
    clients.clear();
  }
  return { handleLine, close };
}
