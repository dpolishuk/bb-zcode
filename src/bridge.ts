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

type Message = Record<string, unknown>;
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
  await session.client.request(
    "provider/testModelConnectivity",
    { workspace: workspaceRef(session.cwd), selection },
    60_000,
  );
  return `ZCode verified connectivity for ${selection.providerId}/${selection.modelId}. This ran one real model request.`;
}

export function createBridge(
  config: {
    write?: (message: Message) => void;
    clientFactory?: ClientFactory;
    env?: NodeJS.ProcessEnv;
    accountFactory?: (launch: LaunchSpec) => AccountHost;
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
  }

  async function finishTurn(
    session: Session,
    status: "completed" | "failed" | "interrupted",
    payload: Message,
  ) {
    if (!session.timeline || session.draining) return;
    session.draining = true;
    try {
      const window = record(session.snapshot.projection).contextWindow;
      emit(
        session,
        session.usage.turn(
          payload.usage,
          typeof window === "number" ? window : null,
        ),
      );
      try {
        const snapshot = snapshotSchema.parse(
          await session.client.request(
            "session/read",
            { sessionId: session.providerThreadId },
            2000,
          ),
        );
        if (!session.stopping) {
          session.snapshot = snapshot;
          session.background.update(snapshot.projection);
          emit(session, session.usage.context(snapshot.projection));
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
          ...(params.disallowedTools?.length
            ? { toolDenylist: params.disallowedTools }
            : {}),
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
        mode,
        starting: false,
        buffered: [],
        stopping: false,
        lastSeq: -1,
        snapshot,
        usage: new Usage(restoredUsage),
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
        /^\/(zcode-tasks|zcode-task-output|zcode-task-stop|zcode-file-preview|zcode-file-rewind|zcode-check)(?:\s+(.*))?$/.exec(
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
          threadArchive: false,
          threadRename: false,
          threadGoalClear: false,
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
          result(id, {
            models: available.length
              ? available.map((model) => {
                  const key = `${model.ref.providerId}/${model.ref.modelId}`;
                  return {
                    id: key,
                    model: key,
                    displayName: model.label,
                    isDefault: key === defaultId,
                    description: model.description ?? "",
                    supportedReasoningEfforts: (
                      model.reasoning?.levels ?? []
                    ).map((level) => ({
                      reasoningEffort: level.value,
                      label: level.label,
                      description: level.description ?? "",
                    })),
                    defaultReasoningEffort:
                      model.reasoning?.defaultLevel ??
                      model.reasoning?.levels[0]?.value ??
                      "none",
                  };
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
    for (const account of accounts.values()) account.close();
    await Promise.allSettled(
      [...sessions.values()].map((session) => release(session, true)),
    );
    await Promise.allSettled([...clients].map((client) => client.close()));
    clients.clear();
  }
  return { handleLine, close };
}
