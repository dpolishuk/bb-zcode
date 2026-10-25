import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { ProtocolError } from "./client.js";
import { record } from "./protocol.js";

// Upstream off-peak contract mirrored from @zcode/shared and
// packages/services on upstream main (pinned 2026-10-24; see
// knowledge/contracts/off-peak-protocol.md). The wire API is not a public
// contract and can change without notice.
export const OFF_PEAK_METHODS = new Set(["offPeak/create", "offPeak/list"]);

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

// The CLI denies these tools on off-peak turns; OffPeakList stays visible.
export const OFF_PEAK_RUN_TOOL_DENYLIST = ["CronCreate", "OffPeakCreate"];

export const OFF_PEAK_CONTINUATION_PROMPT =
  "Continue the previous task from where it left off. The run was interrupted " +
  "(app restart or execution window expired). Do not start over; review what has " +
  "already been done and complete the remaining work.";

const permissionModeSchema = z.enum([
  "build",
  "edit",
  "plan",
  "yolo",
  "guarded",
]);

const taskStatusSchema = z.enum([
  "queued",
  "paused",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export const offPeakTaskSnapshotSchema = z
  .object({
    offPeakTaskId: z.string().min(1),
    title: z.string(),
    status: taskStatusSchema,
    queuePosition: z.number().int().positive().optional(),
    sessionId: z.string().min(1).optional(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();

export type OffPeakTaskSnapshot = z.infer<typeof offPeakTaskSnapshotSchema>;

const createParamsSchema = z
  .object({
    title: z.string().min(1),
    prompt: z.string().min(1),
    permissionMode: permissionModeSchema.optional(),
    model: z.string().min(1).optional(),
    thoughtLevel: z.string().min(1).optional(),
    boundSessionId: z.string().min(1).optional(),
  })
  .strict();

export const createFailureSchema = z.object({
  ok: z.literal(false),
  failureStage: z.enum([
    "client_validation",
    "ticket_request",
    "local_persist",
  ]),
  errorCategory: z.enum([
    "client_validation",
    "eligibility_3101",
    "quota_3103",
    "network",
    "invalid_response",
    "local_persist",
    "unknown",
  ]),
  errorCode: z.string(),
});
export type OffPeakCreateFailure = z.infer<typeof createFailureSchema>;

const storedFieldsSchema = z.object({
  prompt: z.string().min(1),
  status: taskStatusSchema,
  createdAt: z.number().int().nonnegative(),
  queuePosition: z.number().int().positive().optional(),
  boundSessionId: z.string().min(1),
  threadId: z.string().min(1),
  workspacePath: z.string().min(1),
  providerOptions: z.unknown().optional(),
  permissionMode: permissionModeSchema.optional(),
  model: z.string().min(1).optional(),
  thoughtLevel: z.string().min(1).optional(),
  serverTicketId: z.string().min(1).optional(),
  schedulable: z.boolean(),
  nextPollAt: z.number().int().optional(),
  nextDispatchAt: z.number().int().optional(),
  ranOnce: z.boolean().optional(),
  transientFailures: z.number().int().nonnegative().optional(),
  settled: z.boolean().optional(),
  failureReason: z.string().optional(),
  startedAt: z.number().int().optional(),
  endedAt: z.number().int().optional(),
  updatedAt: z.number().int(),
});

export type StoredOffPeakTask = {
  offPeakTaskId: string;
  title: string;
} & z.infer<typeof storedFieldsSchema>;

const storeFileSchema = z.object({
  version: z.literal(1),
  tasks: z.array(
    z
      .object({ offPeakTaskId: z.string().min(1), title: z.string() })
      .and(storedFieldsSchema),
  ),
});

/** Typed gateway error; callers branch on bizCode (3101/3103/3102/3006/3105). */
export class OffPeakServerError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly bizCode?: number,
    readonly nextTakeAt?: number,
  ) {
    super(message);
    this.name = "OffPeakServerError";
  }
}

export type OffPeakTicketState =
  "queued" | "ready" | "active" | "expired" | "settled" | "not_found";

export interface OffPeakServerClient {
  takeTicket(taskId: string): Promise<{
    ticketId: string;
    state: OffPeakTicketState;
    position?: number;
    nextPollAfterMs?: number;
    registeredAt: number;
  }>;
  batchStatus(ticketIds: string[]): Promise<{
    nextPollAfterMs?: number;
    tickets: Array<{
      ticketId: string;
      state: OffPeakTicketState;
      position?: number;
      activeDeadline?: number;
    }>;
  }>;
  settle(ticketId: string): Promise<void>;
}

export interface OffPeakCredentials {
  jwt: string;
  codingPlanApiKey: string;
}

const ticketStateSchema = z.enum([
  "queued",
  "ready",
  "active",
  "expired",
  "settled",
  "not_found",
]);
const errorBodySchema = z
  .object({
    code: z.number().optional(),
    msg: z.string().optional(),
    message: z.string().optional(),
    next_take_at: z.number().optional(),
    data: z
      .object({ next_take_at: z.number().int().positive().optional() })
      .passthrough()
      .nullish(),
  })
  .passthrough();

const REQUEST_TIMEOUT_MS = 10_000;

/** Wire client for the four JSON endpoints; messages calls stay in the CLI. */
export function createOffPeakServerClient(deps: {
  resolveOrigin: () => string | Promise<string>;
  resolveCredentials: () => Promise<OffPeakCredentials>;
  fetchImpl?: typeof fetch;
}): OffPeakServerClient {
  const fetchImpl = deps.fetchImpl ?? fetch;
  async function request(
    method: "GET" | "POST",
    suffix: string,
    body?: unknown,
  ): Promise<unknown> {
    const credentials = await deps.resolveCredentials();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const origin = await deps.resolveOrigin();
      const response = await fetchImpl(
        `${origin.replace(/\/$/, "")}/api/v1/off-peak${suffix}`,
        {
          method,
          headers: {
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
            authorization: `Bearer ${credentials.jwt}`,
            "x-coding-plan-api-key": credentials.codingPlanApiKey,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
        },
      );
      const text = await response.text();
      const json: unknown = text
        ? (JSON.parse(text) as unknown)
        : ({} as unknown);
      if (!response.ok) {
        const parsed = errorBodySchema.safeParse(json);
        const errorBody = parsed.success ? parsed.data : {};
        throw new OffPeakServerError(
          errorBody.msg ??
            errorBody.message ??
            `off-peak gateway ${response.status}`,
          response.status,
          errorBody.code,
          errorBody.next_take_at ?? errorBody.data?.next_take_at,
        );
      }
      return json;
    } catch (failure) {
      if (failure instanceof OffPeakServerError) throw failure;
      throw new OffPeakServerError(
        failure instanceof Error ? failure.message : String(failure),
        0,
      );
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    async takeTicket(taskId) {
      const body = record(
        await request("POST", "/ticket", { task_id: taskId }),
      );
      const state = ticketStateSchema.parse(body.state);
      return {
        ticketId: z.string().min(1).parse(body.ticket_id),
        state,
        ...(body.position === null || body.position === undefined
          ? {}
          : {
              position: z.number().int().nonnegative().parse(body.position) + 1,
            }),
        ...(body.next_poll_after === undefined
          ? {}
          : { nextPollAfterMs: z.number().parse(body.next_poll_after) * 1000 }),
        registeredAt: Date.now(),
      };
    },
    async batchStatus(ticketIds) {
      const body = record(
        await request("POST", "/ticket/status", { ticket_ids: ticketIds }),
      );
      const tickets = Array.isArray(body.tickets)
        ? body.tickets.map(record)
        : [];
      return {
        ...(body.next_poll_after === undefined
          ? {}
          : { nextPollAfterMs: z.number().parse(body.next_poll_after) * 1000 }),
        tickets: tickets.map((entry) => ({
          ticketId: z.string().min(1).parse(entry.ticket_id),
          state: ticketStateSchema.parse(entry.state),
          ...(entry.position === null || entry.position === undefined
            ? {}
            : { position: z.number().parse(entry.position) + 1 }),
          ...(entry.active_deadline === undefined
            ? {}
            : { activeDeadline: z.number().parse(entry.active_deadline) }),
        })),
      };
    },
    async settle(ticketId) {
      await request("POST", `/ticket/${encodeURIComponent(ticketId)}/settle`);
    },
  };
}

function classifyCreateFailure(
  error: unknown,
  failureStage: "client_validation" | "ticket_request" | "local_persist",
): OffPeakCreateFailure {
  let errorCategory: OffPeakCreateFailure["errorCategory"] = "unknown";
  let errorCode = "";
  if (failureStage === "client_validation") errorCategory = "client_validation";
  else if (failureStage === "local_persist") errorCategory = "local_persist";
  else if (error instanceof OffPeakServerError) {
    errorCode = error.bizCode === undefined ? "" : String(error.bizCode);
    if (error.bizCode === 3101) errorCategory = "eligibility_3101";
    else if (error.bizCode === 3103) errorCategory = "quota_3103";
    else if (error.httpStatus === 0) errorCategory = "network";
    else errorCategory = "invalid_response";
  } else errorCategory = "network";
  return { ok: false, failureStage, errorCategory, errorCode };
}

export const OFF_PEAK_SYNC_MIN_MS = 5_000;
export const OFF_PEAK_SYNC_MAX_MS = 5 * 60_000;

/**
 * Off-peak task host: creation/list reverse RPCs, ticket sync loop and
 * dispatch claims over a local JSON store (separate from automations, like
 * the native separate tables).
 */
export function createOffPeakService(options: {
  storeDir?: string;
  now?: () => Date;
  client: OffPeakServerClient;
}) {
  const now = options.now ?? (() => new Date());
  const client = options.client;
  const storeDir =
    options.storeDir ??
    process.env.BB_BRIDGE_DIR ??
    path.join(homedir(), ".bb", "plugins", "zcode", "bridge-data");
  const storePath = path.join(storeDir, "offpeak.json");
  let loaded: StoredOffPeakTask[] | undefined;
  let loading: Promise<void> | undefined;
  let writes: Promise<void> = Promise.resolve();
  const dispatching = new Set<string>();

  function load(): Promise<void> {
    loading ??= (async () => {
      let raw: string;
      try {
        raw = await readFile(storePath, "utf8");
      } catch (failure) {
        if (
          typeof failure === "object" &&
          failure !== null &&
          (failure as { code?: unknown }).code === "ENOENT"
        ) {
          loaded = [];
          return;
        }
        throw failure;
      }
      // Fail closed on a damaged store (same rationale as automations).
      const tasks = storeFileSchema.parse(JSON.parse(raw)).tasks;
      // Interrupted-run recovery, like the native host: a `running` row
      // means the worker died mid-run - requeue it and keep ranOnce so the
      // next dispatch continues the session instead of repeating the
      // original prompt and burning quota again.
      const recovered = tasks.map((task) =>
        task.status === "running"
          ? { ...task, status: "queued" as const, schedulable: false }
          : task,
      );
      loaded = recovered;
      if (recovered.some((task, index) => task !== tasks[index]))
        void persist(recovered).catch(() => undefined);
    })();
    return loading;
  }

  function persist(next: StoredOffPeakTask[]): Promise<void> {
    const attempt = writes.then(async () => {
      await mkdir(storeDir, { recursive: true });
      const tmp = `${storePath}.${randomUUID()}.tmp`;
      await writeFile(
        tmp,
        JSON.stringify({ version: 1, tasks: next }, null, 2),
        "utf8",
      );
      await rename(tmp, storePath);
    });
    writes = attempt.catch(() => undefined);
    return attempt;
  }

  async function mutate(
    id: string,
    apply: (task: StoredOffPeakTask) => StoredOffPeakTask,
  ): Promise<StoredOffPeakTask | undefined> {
    await load();
    const current = loaded!.find((t) => t.offPeakTaskId === id);
    if (!current) return undefined;
    const next = { ...apply(current), updatedAt: now().getTime() };
    loaded = loaded!.map((t) => (t.offPeakTaskId === id ? next : t));
    await persist(loaded);
    return next;
  }

  function snapshot(t: StoredOffPeakTask): OffPeakTaskSnapshot {
    return offPeakTaskSnapshotSchema.parse({
      offPeakTaskId: t.offPeakTaskId,
      title: t.title,
      status: t.status,
      ...(t.queuePosition !== undefined && t.queuePosition !== null
        ? { queuePosition: t.queuePosition }
        : {}),
      ...(t.status !== "queued" || t.ranOnce
        ? { sessionId: t.boundSessionId }
        : {}),
      createdAt: t.createdAt,
    });
  }

  async function create(
    raw: unknown,
    context: {
      threadId: string;
      providerThreadId: string;
      cwd: string;
      providerOptions?: unknown;
    },
  ): Promise<{ ok: true; task: OffPeakTaskSnapshot } | OffPeakCreateFailure> {
    const input = createParamsSchema.parse(raw);
    await load();
    // One non-terminal task per bound session, checked before taking a
    // ticket so refusals do not burn quota.
    const boundSessionId = input.boundSessionId ?? context.providerThreadId;
    if (
      loaded!.some(
        (t) =>
          t.boundSessionId === boundSessionId &&
          !TERMINAL_STATUSES.has(t.status) &&
          t.workspacePath === context.cwd,
      )
    )
      return {
        ok: false,
        failureStage: "client_validation",
        errorCategory: "client_validation",
        errorCode: "session_bound",
      };
    const offPeakTaskId = `offpeak-${randomUUID()}`;
    let ticket;
    try {
      ticket = await client.takeTicket(offPeakTaskId);
    } catch (failure) {
      if (failure instanceof ProtocolError) throw failure;
      return classifyCreateFailure(failure, "ticket_request");
    }
    const at = now().getTime();
    const entry: StoredOffPeakTask = {
      offPeakTaskId,
      title: input.title,
      prompt: input.prompt,
      status: "queued",
      createdAt: at,
      boundSessionId,
      threadId: context.threadId,
      workspacePath: context.cwd,
      ...(context.providerOptions !== undefined
        ? { providerOptions: context.providerOptions }
        : {}),
      ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.thoughtLevel ? { thoughtLevel: input.thoughtLevel } : {}),
      serverTicketId: ticket.ticketId,
      schedulable: ticket.state === "ready",
      ...(ticket.nextPollAfterMs !== undefined
        ? {
            nextPollAt:
              at +
              Math.min(
                Math.max(ticket.nextPollAfterMs, OFF_PEAK_SYNC_MIN_MS),
                OFF_PEAK_SYNC_MAX_MS,
              ),
          }
        : {}),
      ...(ticket.position !== undefined
        ? { queuePosition: ticket.position }
        : {}),
      updatedAt: at,
    };
    loaded = [...loaded!, entry];
    try {
      await persist(loaded);
    } catch (failure) {
      return classifyCreateFailure(failure, "local_persist");
    }
    return { ok: true, task: snapshot(entry) };
  }

  async function list(cwd: string): Promise<{ tasks: OffPeakTaskSnapshot[] }> {
    await load();
    return {
      tasks: loaded!.filter((t) => t.workspacePath === cwd).map(snapshot),
    };
  }

  async function handle(
    method: string,
    raw: unknown,
    context: {
      threadId?: string;
      providerThreadId?: string;
      cwd?: string;
      providerOptions?: unknown;
    },
  ): Promise<unknown> {
    if (method === "offPeak/list") {
      if (!context.cwd)
        throw new ProtocolError(
          "No active bb session for this request.",
          -32601,
        );
      return list(context.cwd);
    }
    if (method === "offPeak/create") {
      if (!context.threadId || !context.providerThreadId || !context.cwd)
        throw new ProtocolError(
          "No active bb session for this request.",
          -32601,
        );
      return create(raw, {
        threadId: context.threadId,
        providerThreadId: context.providerThreadId,
        cwd: context.cwd,
        providerOptions: context.providerOptions,
      });
    }
    throw new ProtocolError(`Unknown off-peak method ${method}.`, -32601);
  }

  /** One batch sync pass: apply ticket states, re-take expired, settle finals. */
  async function syncCycle(): Promise<void> {
    await load();
    const active = loaded!.filter(
      (t) => !TERMINAL_STATUSES.has(t.status) && t.serverTicketId,
    );
    const settleOutbox = loaded!.filter(
      (t) =>
        TERMINAL_STATUSES.has(t.status) &&
        t.settled !== true &&
        t.serverTicketId,
    );
    await Promise.allSettled(
      settleOutbox.map(async (task) => {
        await client.settle(task.serverTicketId!);
        await mutate(task.offPeakTaskId, (t) => ({ ...t, settled: true }));
      }),
    );
    if (!active.length) return;
    const due = active.filter(
      (t) => t.nextPollAt === undefined || t.nextPollAt <= now().getTime(),
    );
    if (!due.length) return;
    let result;
    try {
      result = await client.batchStatus(due.map((t) => t.serverTicketId!));
    } catch {
      // Transient gateway failure: retry on the next tick with backoff.
      const backoff = now().getTime() + 30_000;
      await Promise.allSettled(
        due.map((t) =>
          mutate(t.offPeakTaskId, (task) => ({ ...task, nextPollAt: backoff })),
        ),
      );
      return;
    }
    const byTicket = new Map(result.tickets.map((t) => [t.ticketId, t]));
    for (const task of due) {
      const ticket = byTicket.get(task.serverTicketId!);
      const nextPoll =
        result.nextPollAfterMs === undefined
          ? undefined
          : now().getTime() +
            Math.min(
              Math.max(result.nextPollAfterMs, OFF_PEAK_SYNC_MIN_MS),
              OFF_PEAK_SYNC_MAX_MS,
            );
      if (!ticket) {
        // not_found tickets are re-taken like expired ones.
        await retake(task, nextPoll);
        continue;
      }
      if (ticket.state === "ready" || ticket.state === "active") {
        await mutate(task.offPeakTaskId, (t) => ({
          ...t,
          schedulable: t.status === "queued",
          ...(ticket.position !== undefined
            ? { queuePosition: ticket.position }
            : {}),
          ...(nextPoll !== undefined ? { nextPollAt: nextPoll } : {}),
        }));
      } else if (ticket.state === "expired" || ticket.state === "not_found") {
        // Explicitly vanished tickets re-enter the queue like expired ones.
        await retake(task, nextPoll);
      } else {
        await mutate(task.offPeakTaskId, (t) => ({
          ...t,
          ...(nextPoll !== undefined ? { nextPollAt: nextPoll } : {}),
        }));
      }
    }
  }

  async function retake(
    task: StoredOffPeakTask,
    nextPoll?: number,
  ): Promise<void> {
    if (task.status === "paused" || TERMINAL_STATUSES.has(task.status)) return;
    try {
      const ticket = await client.takeTicket(task.offPeakTaskId);
      await mutate(task.offPeakTaskId, (t) => ({
        ...t,
        serverTicketId: ticket.ticketId,
        schedulable: t.status === "queued" && ticket.state === "ready",
        ...(ticket.position !== undefined
          ? { queuePosition: ticket.position }
          : {}),
        nextPollAt:
          nextPoll ??
          (ticket.nextPollAfterMs === undefined
            ? undefined
            : now().getTime() + ticket.nextPollAfterMs),
      }));
    } catch {
      await mutate(task.offPeakTaskId, (t) => ({
        ...t,
        schedulable: false,
        ...(nextPoll !== undefined ? { nextPollAt: nextPoll } : {}),
      })).catch(() => undefined);
    }
  }

  /** Claimable tasks: ready tickets on queued tasks, FIFO, backoff honored. */
  function due(at: Date): StoredOffPeakTask[] {
    if (!loaded) return [];
    return loaded
      .filter(
        (t) =>
          t.status === "queued" &&
          t.schedulable &&
          t.serverTicketId !== undefined &&
          (t.nextDispatchAt === undefined ||
            t.nextDispatchAt <= at.getTime()) &&
          !dispatching.has(t.offPeakTaskId),
      )
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  function beginRun(id: string): boolean {
    if (dispatching.has(id)) return false;
    dispatching.add(id);
    return true;
  }

  /** Release a claim without any backoff (retry on the next tick). */
  function retryRun(id: string): void {
    dispatching.delete(id);
  }

  /**
   * Persist dispatch progress before the prompt leaves: a worker crash after
   * this point leaves a `running` row that load() recovers as a queued
   * continuation (ranOnce stays true), never a fresh `init` re-run.
   */
  async function markRunning(id: string): Promise<void> {
    await mutate(id, (t) => ({
      ...t,
      status: "running",
      ranOnce: true,
      startedAt: t.startedAt ?? now().getTime(),
    })).catch(() => undefined);
  }

  /** Busy bound session: retry with 30s..15min backoff (native transient). */
  async function deferRun(id: string): Promise<void> {
    dispatching.delete(id);
    const failures = ((await find(id))?.transientFailures ?? 0) + 1;
    const backoff = Math.min(30_000 * 2 ** Math.min(failures, 6), 15 * 60_000);
    await mutate(id, (t) => ({
      ...t,
      status: "queued",
      transientFailures: failures,
      nextDispatchAt: now().getTime() + backoff,
    })).catch(() => undefined);
  }

  /**
   * Record a finished run. `ticketExpired` requeues for continuation (3102);
   * three consecutive transient dispatch failures also fail the task.
   */
  async function completeRun(
    id: string,
    outcome: "completed" | "failed" | "ticketExpired",
    message?: string,
  ): Promise<void> {
    dispatching.delete(id);
    const current = await find(id);
    if (!current || TERMINAL_STATUSES.has(current.status)) return;
    const at = now().getTime();
    if (outcome === "completed") {
      await mutate(id, (t) => ({
        ...t,
        status: "completed",
        ranOnce: true,
        startedAt: t.startedAt ?? at,
        endedAt: at,
        transientFailures: 0,
      }));
      return;
    }
    if (outcome === "ticketExpired") {
      // Same task_id re-take; the next claim continues the session.
      await mutate(id, (t) => ({
        ...t,
        status: "queued",
        ranOnce: true,
        schedulable: false,
        startedAt: t.startedAt ?? at,
        ...(message ? { failureReason: message } : {}),
      }));
      const fresh = await find(id);
      if (fresh) await retake(fresh);
      return;
    }
    const failures = (current.transientFailures ?? 0) + 1;
    if (failures >= 3)
      await mutate(id, (t) => ({
        ...t,
        status: "failed",
        ranOnce: t.ranOnce ?? true,
        endedAt: at,
        failureReason: message ?? "Run failed",
      }));
    else
      await mutate(id, (t) => ({
        ...t,
        status: "queued",
        ranOnce: t.ranOnce ?? false,
        schedulable: false,
        transientFailures: failures,
        nextDispatchAt: at + 30_000,
        ...(message ? { failureReason: message } : {}),
      }));
  }

  async function cancel(id: string, cwd: string): Promise<boolean> {
    await load();
    const task = loaded!.find(
      (t) => t.offPeakTaskId === id && t.workspacePath === cwd,
    );
    if (!task) return false;
    if (!TERMINAL_STATUSES.has(task.status))
      await mutate(id, (t) => ({
        ...t,
        status: "cancelled",
        endedAt: now().getTime(),
        schedulable: false,
      }));
    return true;
  }

  async function find(id: string): Promise<StoredOffPeakTask | undefined> {
    await load();
    return loaded!.find((t) => t.offPeakTaskId === id);
  }

  function describe(cwd: string): string {
    if (!loaded) return "Idle-time tasks are not loaded yet.";
    const scoped = loaded.filter((t) => t.workspacePath === cwd);
    if (!scoped.length)
      return "No idle-time tasks. Create one in a ZCode session with OffPeakCreate.";
    return scoped
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((t) =>
        [
          `${t.offPeakTaskId}  ${t.status}${t.schedulable ? " (ready)" : ""}`,
          `  ${t.title}`,
          `  position: ${t.queuePosition ?? "-"}  created: ${new Date(t.createdAt).toISOString()}`,
          ...(t.failureReason ? [`  last error: ${t.failureReason}`] : []),
        ].join("\n"),
      )
      .join("\n\n");
  }

  function ready(): Promise<void> {
    return load();
  }

  return {
    handle,
    syncCycle,
    due,
    beginRun,
    deferRun,
    retryRun,
    markRunning,
    completeRun,
    cancel,
    find,
    describe,
    ready,
  };
}

export type OffPeakService = ReturnType<typeof createOffPeakService>;
