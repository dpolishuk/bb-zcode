import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  initializeParamsSchema,
  modelListParamsSchema,
  providerMaintenanceParamsSchema,
  threadStartParamsSchema,
  threadResumeParamsSchema,
  threadStopParamsSchema,
  threadDiscardParamsSchema,
  turnStartParamsSchema,
  turnSteerParamsSchema,
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
  type Snapshot,
} from "./protocol.js";
import { Timeline, toolPresentation } from "./timeline.js";
import { CodingPlanHost, type AccountHost } from "./coding-plan.js";
import { nativeInput } from "./input.js";
import { Usage } from "./usage.js";
import { runtimeSettings } from "./settings.js";

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
  compacting: boolean;
  draining: boolean;
  queue: Array<z.infer<typeof turnSteerParamsSchema>>;
  accepted: Set<string>;
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
  "thread/start": threadStartParamsSchema,
  "thread/resume": threadResumeParamsSchema,
  "thread/stop": threadStopParamsSchema,
  "thread/discard": threadDiscardParamsSchema,
  "turn/start": turnStartParamsSchema,
  "turn/steer": turnSteerParamsSchema,
};
const modeFor = (options: BridgeExecutionOptions) =>
  options.promptMode === "plan"
    ? "plan"
    : options.permissionMode === "full"
      ? "yolo"
      : "build";

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
  ) {
    const timeline = session.timeline;
    session.timeline = undefined;
    session.activeTurnId = undefined;
    session.compacting = false;
    timeline?.finish(status, response);
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
          emit(session, session.usage.context(snapshot.projection));
        }
      } catch {
        /* Usage queries must never prevent a turn from settling. */
      }
      if (!session.stopping) settle(session, status, text(payload.response));
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
      session.timeline = new Timeline((deltas) => emit(session, deltas));
      emit(session, [
        {
          kind: "turn.open",
        },
      ]);
    }
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
    } else session.timeline.event(event.type, event.payload);
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
    },
  ): Promise<unknown> {
    if (method === "session/requestRuntimePreferences")
      return context?.preferences ?? RUNTIME_PREFERENCES;
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

  async function release(session: Session, interrupt: boolean) {
    session.stopping = true;
    session.queue = [];
    session.account.close();
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
    clients.delete(session.client);
    accounts.delete(session.client);
    sessions.delete(session.threadId);
    emit(session, [{ kind: "session.ended" }]);
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
    try {
      const launch = resolveLaunch(params.options.providerOptions, {
        ...(config.env ?? process.env),
        ...params.options.envVars,
      });
      account = config.accountFactory?.(launch) ?? new CodingPlanHost(launch);
      const settings = runtimeSettings(params.options.providerOptions);
      const context = {
        account,
        cwd: params.cwd,
        preferences: settings.preferences,
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
          ...(settings.mcpServers.length
            ? { mcpServers: settings.mcpServers }
            : {}),
          ...(params.disallowedTools?.length
            ? { toolDenylist: params.disallowedTools }
            : {}),
        },
      );
      const snapshot = snapshotSchema.parse(response);
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
      emit(session, [{ kind: "session.reset" }]);
      return session;
    } catch (failure) {
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
      const compact = !material.attachments && prompt.trim() === "/compact";
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
                  content: session.instructions
                    ? `<bb_instructions>\n${session.instructions}\n</bb_instructions>\n\n${prompt}`
                    : prompt,
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
      if (session.stopping)
        throw new Error("Session stopped while submitting the prompt.");
      session.instructions = undefined;
      if (clientRequestId) {
        session.accepted.add(clientRequestId);
        if (session.accepted.size > 1024)
          session.accepted.delete(session.accepted.values().next().value!);
      }
      session.compacting = compact;
      session.timeline = new Timeline((deltas) => emit(session, deltas));
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

  async function probe(raw: Message, cwd = homedir()) {
    const launch = resolveLaunch(
      raw.providerOptions,
      config.env ?? process.env,
    );
    const account =
      config.accountFactory?.(launch) ?? new CodingPlanHost(launch);
    const settings = runtimeSettings(raw.providerOptions);
    const client = factory(
      launch,
      cwd,
      {
        notification() {},
        request: (method, params) =>
          reverseRequest(undefined, method, params, {
            account,
            cwd,
            preferences: settings.preferences,
          }),
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
        accountError &&
        !snapshot.settings.model.available.some(
          (model) => !model.disabledReason,
        )
      )
        throw new Error(accountError);
      return snapshot;
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
          fork: "none",
          approvalEnforcedBy: "runtime",
          steerMode: "queue",
          skills: { configure: false },
        },
      });
      return;
    }
    if (method === "model/list" || method === "provider/health") {
      const p = record(parsed.data);
      try {
        const snapshot = await probe(p, text(p.cwd) || homedir());
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
                ? "ZCode protocol responds. Model connectivity has not been tested."
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
    if (method === "thread/start" || method === "thread/resume") {
      const params = parsed.data as z.infer<typeof threadStartParamsSchema>;
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
      if (!interrupt && (session.timeline || session.starting))
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
