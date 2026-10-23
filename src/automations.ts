import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import { ProtocolError } from "./client.js";
import { modelRefSchema } from "./protocol.js";

// Native automation contract mirrored from @zcode/shared on upstream main
// (pinned 2026-10-23). The CLI validates every result with its own strict
// schemas, so field names, enums and the exact field set must match.
export const AUTOMATION_METHODS = new Set([
  "automation/create",
  "automation/update",
  "automation/list",
  "automation/delete",
  "automation/checkTaskBinding",
]);

export const CRON_TOOL_NAMES = [
  "CronCreate",
  "CronList",
  "CronUpdate",
  "CronDelete",
] as const;

// Upstream keeps at most 20 definitions per index; the CLI recognizes the
// limit through this token in the message and stops its retry loops.
const CREATE_LIMIT = 20;
const CREATE_LIMIT_TOKEN = "AUTOMATION_CREATE_LIMIT_REACHED";

const intervalUnitSchema = z.enum([
  "minute",
  "hourly",
  "daily",
  "weekly",
  "monthly",
  "yearly",
]);
type IntervalUnit = z.infer<typeof intervalUnitSchema>;

const scheduleRuleSchema = z
  .object({
    unit: intervalUnitSchema,
    interval: z.number().int().positive(),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    anchorAt: z.number().int(),
    weekdays: z.array(z.number().int().min(0).max(6)).optional(),
    monthDays: z.array(z.number().int().min(1).max(31)).optional(),
    months: z.array(z.number().int().min(1).max(12)).optional(),
    monthlyMode: z.enum(["date", "weekday"]).optional(),
  })
  .strict();
type ScheduleRule = z.infer<typeof scheduleRuleSchema>;

// Desktop-grade mode vocabulary the CLI normalizes into the snapshot.
const taskModeSchema = z.enum([
  "plan",
  "edit",
  "guarded",
  "yolo",
  "build",
  "dontAsk",
  "bypassPermissions",
  "default",
  "auto",
  "acceptEdits",
  "autoEdit",
]);

export const automationSnapshotSchema = z
  .object({
    automationId: z.string().min(1),
    title: z.string(),
    cronExpr: z.string().min(1),
    prompt: z.string().min(1),
    modelSelection: modelRefSchema.optional(),
    mode: taskModeSchema.optional(),
    targetTaskId: z.string().min(1).optional(),
    enabled: z.boolean(),
    lifecycleStatus: z.enum(["active", "completed", "failed", "paused"]),
    nextRunAt: z.number().int().optional(),
    lastRunAt: z.number().int().optional(),
    runCount: z.number().int().nonnegative(),
    recurring: z.boolean(),
    maxRuns: z.number().int().positive().optional(),
    scheduleRule: scheduleRuleSchema.optional(),
  })
  .strict();

export type AutomationSnapshot = z.infer<typeof automationSnapshotSchema>;

const createParamsSchema = z
  .object({
    title: z.string().optional(),
    cronExpr: z.string().min(1),
    relativeDelayMinutes: z.number().int().positive().max(525_600).optional(),
    prompt: z.string().min(1),
    modelSelection: modelRefSchema.optional(),
    mode: taskModeSchema.optional(),
    targetTaskId: z.string().min(1).optional(),
    botDeliveryTarget: z.unknown().optional(),
    recurring: z.boolean().optional(),
    maxRuns: z.number().int().positive().optional(),
    intervalUnit: intervalUnitSchema.optional(),
    interval: z.number().int().min(1).max(200).optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if ((input.intervalUnit === undefined) !== (input.interval === undefined))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "intervalUnit and interval must be set together",
        path: ["interval"],
      });
    if (
      input.intervalUnit !== undefined &&
      input.relativeDelayMinutes !== undefined
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "intervalUnit cannot combine with a relative delayMinutes",
        path: ["intervalUnit"],
      });
    if (input.intervalUnit !== undefined && input.recurring === false)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "intervalUnit is a recurring carrier and cannot combine with recurring=false",
        path: ["recurring"],
      });
    if (input.intervalUnit !== undefined && input.maxRuns !== undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "intervalUnit is a recurring carrier and cannot combine with maxRuns",
        path: ["maxRuns"],
      });
  });

const updateParamsSchema = z
  .object({
    automationId: z.string().min(1),
    title: z.string().min(1).optional(),
    cronExpr: z.string().min(1).optional(),
    prompt: z.string().min(1).optional(),
    recurring: z.boolean().optional(),
    maxRuns: z.number().int().positive().nullable().optional(),
    intervalUnit: intervalUnitSchema.optional(),
    interval: z.number().int().min(1).max(200).optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    const carrierSwitch = input.intervalUnit !== undefined;
    if (
      input.title === undefined &&
      input.cronExpr === undefined &&
      input.prompt === undefined &&
      input.recurring === undefined &&
      input.maxRuns === undefined &&
      !carrierSwitch
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "automation update requires at least one field",
      });
    if (input.maxRuns === null && input.recurring !== true)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "clearing maxRuns requires recurring=true",
        path: ["maxRuns"],
      });
    if (input.recurring === true && typeof input.maxRuns === "number")
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "recurring=true cannot be combined with a numeric maxRuns",
        path: ["maxRuns"],
      });
    if ((input.intervalUnit === undefined) !== (input.interval === undefined))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "intervalUnit and interval must be set together",
        path: ["interval"],
      });
    if (carrierSwitch && input.recurring === false)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "intervalUnit is a recurring carrier and cannot combine with recurring=false",
        path: ["recurring"],
      });
    if (
      carrierSwitch &&
      input.maxRuns !== undefined &&
      !(input.maxRuns === null && input.recurring === true)
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "intervalUnit is a recurring carrier and only allows maxRuns=null with recurring=true",
        path: ["maxRuns"],
      });
  });

const storedFieldsSchema = z.object({
  threadId: z.string().min(1),
  workspacePath: z.string().min(1),
  providerOptions: z.unknown().optional(),
  createdAt: z.number().int(),
  lastError: z.string().optional(),
  consecutiveFailures: z.number().int().nonnegative().optional(),
});

export type StoredAutomation = z.infer<typeof automationSnapshotSchema> &
  z.infer<typeof storedFieldsSchema>;

const storeFileSchema = z.object({
  version: z.literal(1),
  automations: z.array(automationSnapshotSchema.and(storedFieldsSchema)),
});

const FIXED_UNIT_MS: Partial<Record<IntervalUnit, number>> = {
  minute: 60_000,
  hourly: 3_600_000,
  daily: 86_400_000,
  weekly: 604_800_000,
};

function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  const day = result.getDate();
  result.setDate(1);
  result.setMonth(result.getMonth() + months);
  const lastDay = new Date(
    result.getFullYear(),
    result.getMonth() + 1,
    0,
  ).getDate();
  result.setDate(Math.min(day, lastDay));
  return result;
}

function nextFromSchedule(
  rule: ScheduleRule,
  from: number,
): number | undefined {
  const stepMs = FIXED_UNIT_MS[rule.unit];
  if (stepMs !== undefined) {
    const period = stepMs * rule.interval;
    // `from` is exclusive: a carrier created at `now` first fires one full
    // period later, not immediately.
    const elapsed = from - rule.anchorAt;
    const steps =
      elapsed <= 0 ? (elapsed === 0 ? 1 : 0) : Math.ceil(elapsed / period);
    return rule.anchorAt + steps * period;
  }
  // Monthly/yearly carriers keep the anchor's day and wall-clock time.
  const anchor = new Date(rule.anchorAt);
  const monthsPerStep =
    rule.unit === "yearly" ? 12 * rule.interval : rule.interval;
  const fromDate = new Date(from);
  const monthDistance =
    (fromDate.getFullYear() - anchor.getFullYear()) * 12 +
    (fromDate.getMonth() - anchor.getMonth());
  for (let step = 0; step < 2_400; step += 1) {
    const candidate = addMonths(anchor, (monthDistance + step) * monthsPerStep);
    candidate.setHours(rule.hour, rule.minute, 0, 0);
    if (candidate.getTime() >= from) return candidate.getTime();
  }
  return undefined;
}

function nextFromCron(cronExpr: string, from: Date): number {
  try {
    return CronExpressionParser.parse(cronExpr, { currentDate: from })
      .next()
      .toDate()
      .getTime();
  } catch {
    throw new ProtocolError(`Invalid cron expression "${cronExpr}".`, -32602);
  }
}

function carrierSchedule(
  unit: IntervalUnit,
  interval: number,
  now: Date,
): ScheduleRule {
  return {
    unit,
    interval,
    hour: now.getHours(),
    minute: now.getMinutes(),
    anchorAt: now.getTime(),
  };
}

function nextOccurrence(a: StoredAutomation, from: number): number | undefined {
  if (a.scheduleRule) return nextFromSchedule(a.scheduleRule, from);
  return nextFromCron(a.cronExpr, new Date(from));
}

function snapshot(a: StoredAutomation): AutomationSnapshot {
  return automationSnapshotSchema.parse({
    automationId: a.automationId,
    title: a.title,
    cronExpr: a.cronExpr,
    prompt: a.prompt,
    ...(a.modelSelection ? { modelSelection: a.modelSelection } : {}),
    ...(a.mode ? { mode: a.mode } : {}),
    ...(a.targetTaskId ? { targetTaskId: a.targetTaskId } : {}),
    enabled: a.enabled,
    lifecycleStatus: a.lifecycleStatus,
    ...(a.nextRunAt !== undefined ? { nextRunAt: a.nextRunAt } : {}),
    ...(a.lastRunAt !== undefined ? { lastRunAt: a.lastRunAt } : {}),
    runCount: a.runCount,
    recurring: a.recurring,
    ...(a.maxRuns !== undefined ? { maxRuns: a.maxRuns } : {}),
    ...(a.scheduleRule ? { scheduleRule: a.scheduleRule } : {}),
  });
}

export interface AutomationHandlerContext {
  threadId?: string;
  providerThreadId?: string;
  cwd?: string;
  providerOptions?: unknown;
}

/** Answer the native automation reverse RPCs from a local JSON store. */
export function createAutomationService(options?: {
  storeDir?: string;
  now?: () => Date;
}) {
  const now = options?.now ?? (() => new Date());
  const storeDir =
    options?.storeDir ??
    process.env.BB_BRIDGE_DIR ??
    path.join(homedir(), ".bb", "plugins", "zcode", "bridge-data");
  const storePath = path.join(storeDir, "automations.json");
  let loaded: StoredAutomation[] | undefined;
  let loading: Promise<void> | undefined;
  // Serialized writes: each caller awaits its own write, the chain keeps
  // running even when one write fails.
  let writes: Promise<void> = Promise.resolve();
  const runs = new Map<
    string,
    { inFlight: boolean; deferUntil: number; firstDueAt: number }
  >();

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
      // A store that cannot be parsed must fail closed: answering "unbound"
      // from an empty replacement would silently re-open recursive creation,
      // and rewriting would erase the user's schedules.
      loaded = storeFileSchema.parse(JSON.parse(raw)).automations;
    })();
    return loading;
  }

  function persist(next: StoredAutomation[]): Promise<void> {
    const attempt = writes.then(async () => {
      await mkdir(storeDir, { recursive: true });
      const tmp = `${storePath}.${randomUUID()}.tmp`;
      await writeFile(
        tmp,
        JSON.stringify({ version: 1, automations: next }, null, 2),
        "utf8",
      );
      await rename(tmp, storePath);
    });
    writes = attempt.catch(() => undefined);
    return attempt;
  }

  async function create(
    raw: unknown,
    context: Required<
      Pick<AutomationHandlerContext, "threadId" | "providerThreadId" | "cwd">
    > &
      AutomationHandlerContext,
  ): Promise<{ automation: AutomationSnapshot }> {
    const input = createParamsSchema.parse(raw);
    await load();
    const existing = loaded!;
    if (existing.length >= CREATE_LIMIT)
      throw new ProtocolError(
        `${CREATE_LIMIT_TOKEN}: at most ${CREATE_LIMIT} scheduled tasks are stored. Delete unused tasks first.`,
        -32000,
      );
    // One automation per session, permanently - the CLI checks this before
    // calling; the store is the authoritative second gate.
    const boundTaskId = input.targetTaskId ?? context.providerThreadId;
    if (boundTaskId && existing.some((a) => a.targetTaskId === boundTaskId))
      throw new ProtocolError(
        "Cannot create a scheduled task inside a session that already belongs to a scheduled task. Ask the user to start a new chat to create another scheduled task.",
        -32000,
      );
    const at = now();
    const hasRelative = input.relativeDelayMinutes !== undefined;
    const hasCarrier = input.intervalUnit !== undefined;
    const recurring = hasRelative
      ? false
      : hasCarrier
        ? true
        : (input.recurring ?? true);
    // The CLI sends targetTaskId explicitly; the session fallback keeps the
    // binding authoritative when it is omitted.
    const targetTaskId = boundTaskId;
    const title = (input.title ?? "").trim() || input.prompt.slice(0, 60);
    const scheduleRule = hasCarrier
      ? carrierSchedule(input.intervalUnit!, input.interval!, at)
      : undefined;
    const nextRunAt = hasRelative
      ? at.getTime() + input.relativeDelayMinutes! * 60_000
      : scheduleRule
        ? nextFromSchedule(scheduleRule, at.getTime() + 1)
        : nextFromCron(input.cronExpr, at);
    const entry: StoredAutomation = {
      automationId: randomUUID(),
      title,
      cronExpr: input.cronExpr,
      prompt: input.prompt,
      ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
      ...(targetTaskId ? { targetTaskId } : {}),
      enabled: true,
      lifecycleStatus: "active",
      nextRunAt,
      runCount: 0,
      recurring,
      ...(input.maxRuns !== undefined ? { maxRuns: input.maxRuns } : {}),
      ...(scheduleRule ? { scheduleRule } : {}),
      threadId: context.threadId,
      workspacePath: context.cwd,
      ...(context.providerOptions !== undefined
        ? { providerOptions: context.providerOptions }
        : {}),
      createdAt: at.getTime(),
    };
    loaded = [...existing, entry];
    await persist(loaded);
    return { automation: snapshot(entry) };
  }

  async function update(
    raw: unknown,
  ): Promise<{ automation: AutomationSnapshot }> {
    const input = updateParamsSchema.parse(raw);
    await load();
    const current = loaded!.find((a) => a.automationId === input.automationId);
    if (!current) throw new ProtocolError("Unknown scheduled task.", -32602);
    const at = now();
    const carrierSwitch =
      input.intervalUnit !== undefined && input.interval !== undefined;
    const scheduleChanged =
      carrierSwitch ||
      input.cronExpr !== undefined ||
      input.recurring !== undefined ||
      input.maxRuns !== undefined;
    const scheduleRule = carrierSwitch
      ? carrierSchedule(input.intervalUnit!, input.interval!, at)
      : current.scheduleRule;
    const recurring = carrierSwitch
      ? true
      : (input.recurring ?? current.recurring);
    const maxRuns = carrierSwitch
      ? undefined
      : input.maxRuns === null
        ? undefined
        : (input.maxRuns ?? current.maxRuns);
    // A finished schedule only reactivates when its schedule semantics change;
    // cosmetic updates must not resurrect completed one-shots.
    const lifecycleStatus =
      current.lifecycleStatus === "active" || scheduleChanged
        ? "active"
        : current.lifecycleStatus;
    const probe: StoredAutomation = {
      ...current,
      recurring,
      cronExpr: input.cronExpr ?? current.cronExpr,
      ...(scheduleRule ? { scheduleRule } : {}),
    };
    if (!scheduleRule) delete probe.scheduleRule;
    const nextRunAt =
      lifecycleStatus === "active"
        ? nextOccurrence(probe, at.getTime() + 1)
        : current.nextRunAt;
    const next: StoredAutomation = {
      ...current,
      title: input.title ?? current.title,
      cronExpr: input.cronExpr ?? current.cronExpr,
      prompt: input.prompt ?? current.prompt,
      recurring,
      lifecycleStatus,
      consecutiveFailures: 0,
      ...(nextRunAt !== undefined ? { nextRunAt } : {}),
    };
    if (maxRuns !== undefined) next.maxRuns = maxRuns;
    else delete next.maxRuns;
    if (scheduleRule) next.scheduleRule = scheduleRule;
    else delete next.scheduleRule;
    if (nextRunAt === undefined) delete next.nextRunAt;
    loaded = loaded!.map((a) =>
      a.automationId === current.automationId ? next : a,
    );
    await persist(loaded);
    return { automation: snapshot(next) };
  }

  async function remove(raw: unknown): Promise<{ deleted: boolean }> {
    const input = z
      .object({ automationId: z.string().min(1) })
      .strict()
      .parse(raw);
    await load();
    const before = loaded!.length;
    loaded = loaded!.filter((a) => a.automationId !== input.automationId);
    runs.delete(input.automationId);
    if (loaded!.length === before) return { deleted: false };
    await persist(loaded);
    return { deleted: true };
  }

  async function list(): Promise<{ automations: AutomationSnapshot[] }> {
    await load();
    return { automations: loaded!.map(snapshot) };
  }

  function checkTaskBinding(raw: unknown): { bound: boolean } {
    const input = z
      .object({ targetTaskId: z.string().min(1) })
      .strict()
      .parse(raw);
    // Cron bindings are permanent for the session's lifetime: every
    // lifecycle status counts, mirroring the native EXISTS semantics. An
    // unloaded store answers nothing - unknown must not read as unbound.
    if (!loaded)
      throw new ProtocolError("Scheduled task store is not ready.", -32000);
    return {
      bound: loaded.some((a) => a.targetTaskId === input.targetTaskId),
    };
  }

  function due(at: Date): StoredAutomation[] {
    if (!loaded) return [];
    return loaded.filter(
      (a) =>
        a.enabled &&
        a.lifecycleStatus === "active" &&
        a.nextRunAt !== undefined &&
        a.nextRunAt <= at.getTime(),
    );
  }

  /** Reserve a due automation for dispatch; false skips this tick. */
  function beginRun(id: string, at: Date): boolean {
    const state = runs.get(id) ?? {
      inFlight: false,
      deferUntil: 0,
      firstDueAt: 0,
    };
    if (state.inFlight || state.deferUntil > at.getTime()) return false;
    state.inFlight = true;
    state.firstDueAt ||= at.getTime();
    runs.set(id, state);
    return true;
  }

  /** Release a reservation without recording a run (session was busy). */
  function deferRun(id: string, at: Date): void {
    const state = runs.get(id);
    if (!state) return;
    state.inFlight = false;
    state.deferUntil = at.getTime() + 60_000;
  }

  /** Release a reservation without any defer window (retry next tick). */
  function retryRun(id: string): void {
    const state = runs.get(id);
    if (!state) return;
    state.inFlight = false;
    state.deferUntil = 0;
  }

  function runOverdue(id: string, at: Date): boolean {
    const state = runs.get(id);
    return state !== undefined && at.getTime() - state.firstDueAt > 10 * 60_000;
  }

  async function completeRun(
    id: string,
    ok: boolean,
    message?: string,
  ): Promise<void> {
    runs.delete(id);
    await load();
    const current = loaded!.find((a) => a.automationId === id);
    if (!current) return;
    const at = now().getTime();
    const failures = ok ? 0 : (current.consecutiveFailures ?? 0) + 1;
    let lifecycleStatus = current.lifecycleStatus;
    if (ok) {
      if (!current.recurring) lifecycleStatus = "completed";
      else if (
        current.maxRuns !== undefined &&
        current.runCount + 1 >= current.maxRuns
      )
        lifecycleStatus = "completed";
    } else if (!current.recurring || failures >= 3) lifecycleStatus = "failed";
    const nextRunAt =
      lifecycleStatus === "active"
        ? nextOccurrence({ ...current }, at + 1)
        : undefined;
    const next: StoredAutomation = {
      ...current,
      lifecycleStatus,
      runCount: current.runCount + 1,
      lastRunAt: at,
      consecutiveFailures: failures,
      ...(ok ? {} : { lastError: message ?? "Run failed" }),
    };
    if (nextRunAt !== undefined) next.nextRunAt = nextRunAt;
    else delete next.nextRunAt;
    loaded = loaded!.map((a) => (a.automationId === id ? next : a));
    await persist(loaded);
  }

  async function handle(
    method: string,
    raw: unknown,
    context: AutomationHandlerContext,
  ): Promise<unknown> {
    if (method === "automation/list") return list();
    if (method === "automation/delete") return remove(raw);
    if (method === "automation/checkTaskBinding") {
      await load();
      return checkTaskBinding(raw);
    }
    if (method === "automation/create") {
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
    if (method === "automation/update") return update(raw);
    throw new ProtocolError(`Unknown automation method ${method}.`, -32601);
  }

  function describe(): string {
    if (!loaded) return "Scheduled tasks are not loaded yet.";
    if (!loaded.length)
      return "No scheduled tasks. Create one in a ZCode session with CronCreate.";
    return loaded
      .slice()
      .sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity))
      .map((a) => {
        const when = a.nextRunAt ? new Date(a.nextRunAt).toISOString() : "-";
        return [
          `${a.automationId}  ${a.lifecycleStatus}${a.enabled ? "" : " (disabled)"}`,
          `  ${a.title}`,
          `  next: ${when}  runs: ${a.runCount}  recurring: ${a.recurring}`,
          ...(a.lastError ? [`  last error: ${a.lastError}`] : []),
        ].join("\n");
      })
      .join("\n\n");
  }

  async function removeById(id: string): Promise<boolean> {
    return (await remove({ automationId: id })).deleted;
  }

  /** Full stored record for the dispatcher (private fields included). */
  async function find(id: string): Promise<StoredAutomation | undefined> {
    await load();
    return loaded!.find((a) => a.automationId === id);
  }

  /** Load the store so scheduler ticks can see persisted schedules. */
  function ready(): Promise<void> {
    return load();
  }

  return {
    handle,
    due,
    beginRun,
    deferRun,
    retryRun,
    runOverdue,
    completeRun,
    describe,
    removeById,
    find,
    ready,
  };
}

export type AutomationService = ReturnType<typeof createAutomationService>;

/** bb permission modes cannot express every native mode; collapse like the CLI port. */
export function dispatchPermissionMode(
  mode: AutomationSnapshot["mode"],
): "plan" | "accept-edits" | "full" {
  switch (mode) {
    case "plan":
      return "plan";
    case "yolo":
    case "dontAsk":
    case "bypassPermissions":
      return "full";
    default:
      return "accept-edits";
  }
}
