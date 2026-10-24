import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  ThreadDelta,
  DeltaItemShape,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { ZCodeConnection } from "./client.js";
import { ProtocolError } from "./client.js";
import { record, text } from "./protocol.js";

const rowSchema = z
  .object({
    rowId: z.number().int().nonnegative(),
    entityId: z.string().optional(),
    kind: z.string(),
    turnId: z.string().optional(),
    state: z.string().optional(),
    actions: z
      .object({
        canFork: z.boolean().optional(),
        canRewindFiles: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
const rangeSchema = z.object({
  rows: z.array(rowSchema).max(200),
  atSeq: z.number().int().nonnegative(),
  atRevision: z.number().int().nonnegative(),
  atLogEpoch: z.string().min(1),
  hasMore: z.boolean(),
});
type Range = z.infer<typeof rangeSchema>;
type Row = Range["rows"][number];
const tokenSchema = z
  .object({
    v: z.literal(1),
    sessionId: z.string().min(1),
    epoch: z.string().min(1),
    rowId: z.number().int().nonnegative(),
    entityId: z.string().min(1),
    fingerprint: z.string().length(64),
  })
  .strict();
const fail = (message: string): never => {
  throw new ProtocolError(message, -32000);
};

/** Bounded v4 control queries; the legacy stream remains the only prompt lane. */
export class History {
  constructor(
    private client: ZCodeConnection,
    readonly sessionId: string,
  ) {}
  async rows(beforeRowId?: number): Promise<Range> {
    const raw = await this.client.request("v4/conversation/rowsRange", {
      sessionId: this.sessionId,
      limit: 200,
      ...(beforeRowId === undefined ? {} : { beforeRowId }),
    });
    const parsed = rangeSchema.safeParse(raw);
    if (!parsed.success)
      return fail(
        "This ZCode CLI does not expose compatible v4 history controls. Update ZCode.",
      );
    const rows = parsed.data.rows;
    if (
      rows.some((r, i) => i > 0 && r.rowId <= rows[i - 1]!.rowId) ||
      (beforeRowId !== undefined && rows.some((r) => r.rowId >= beforeRowId))
    )
      return fail("ZCode returned inconsistent history rows.");
    return parsed.data;
  }
  encode(range: Range, row: Row) {
    return (
      "zcode-v1-" +
      Buffer.from(
        JSON.stringify({
          v: 1,
          sessionId: this.sessionId,
          epoch: range.atLogEpoch,
          rowId: row.rowId,
          entityId: row.entityId,
          fingerprint: createHash("sha256")
            .update(text(row.text))
            .digest("hex"),
        }),
      ).toString("base64url")
    );
  }
  latest(range: Range) {
    const row = [...range.rows]
      .reverse()
      .find(
        (r) =>
          r.kind === "assistantText" &&
          r.state === "complete" &&
          r.actions?.canFork === true &&
          r.entityId,
      );
    // Never silently drop a newer unfinished/empty logical turn.
    if (
      !row ||
      range.rows.some(
        (r) => r.rowId > row.rowId && r.turnId && r.turnId !== row.turnId,
      )
    )
      return undefined;
    return row;
  }
  async checkpoint(afterRowId: number) {
    const range = await this.rows();
    const row = this.latest(range);
    return row && row.rowId > afterRowId ? this.encode(range, row) : undefined;
  }
  async target(checkpoint?: string): Promise<{ range: Range; row: Row }> {
    let token: z.infer<typeof tokenSchema> | undefined;
    if (checkpoint !== undefined) {
      try {
        if (!checkpoint.startsWith("zcode-v1-") || checkpoint.length > 4096)
          throw new Error();
        token = tokenSchema.parse(
          JSON.parse(
            Buffer.from(checkpoint.slice(9), "base64url").toString("utf8"),
          ),
        );
        if (token.sessionId !== this.sessionId) throw new Error();
      } catch {
        return fail(
          "Invalid checkpoint or checkpoint belongs to another ZCode session.",
        );
      }
    }
    let range = await this.rows();
    if (!token) {
      const row = this.latest(range);
      if (!row)
        return fail(
          "No stable assistant checkpoint at the ZCode conversation tip.",
        );
      return { range, row };
    }
    const revision = range.atRevision,
      epoch = range.atLogEpoch;
    for (let page = 0; page < 50; page++) {
      if (range.atLogEpoch !== epoch || range.atRevision !== revision)
        return fail(
          "ZCode history changed; the checkpoint is stale. Retry from the current history.",
        );
      const row = range.rows.find(
        (r) =>
          (epoch !== token!.epoch || r.rowId === token!.rowId) &&
          r.entityId === token!.entityId,
      );
      if (row) {
        if (
          createHash("sha256").update(text(row.text)).digest("hex") !==
          token.fingerprint
        )
          return fail(
            "ZCode checkpoint content changed; no other row was substituted.",
          );
        if (
          row.kind !== "assistantText" ||
          row.state !== "complete" ||
          row.actions?.canFork !== true
        )
          return fail("ZCode checkpoint is no longer forkable.");
        return { range, row };
      }
      if (
        !range.hasMore ||
        !range.rows.length ||
        (epoch === token.epoch && range.rows[0]!.rowId <= token.rowId)
      )
        break;
      range = await this.rows(range.rows[0]!.rowId);
    }
    return fail(
      "ZCode checkpoint is missing or outside the bounded history window; no later checkpoint was substituted.",
    );
  }
  async command(type: string, payload: unknown, range?: Range) {
    const commandId = randomUUID();
    const ack = record(
      await this.client.request("v4/command", {
        commandId,
        clientId: "bb-zcode",
        sessionId: this.sessionId,
        type,
        payload,
        issuedAt: Date.now(),
        ...(range
          ? { baseRevision: range.atRevision, baseLogEpoch: range.atLogEpoch }
          : {}),
      }),
    );
    if (
      ack.commandId !== commandId ||
      !["accepted", "duplicate"].includes(text(ack.status))
    )
      return fail(
        `ZCode ${type} did not succeed (${text(ack.status, "invalid acknowledgement")}: ${text(ack.reasonCode, text(ack.message))}).`,
      );
    return record(ack.result);
  }
  private preview?: {
    id: string;
    range: Range;
    target: { rowId: number; entityId: string };
    expires: number;
  };
  async previewFiles(checkpoint?: string) {
    this.preview = undefined;
    let { range, row } = await this.target(checkpoint);
    const revision = range.atRevision,
      epoch = range.atLogEpoch;
    let header = range.rows.find(
      (r) => r.kind === "turnHeader" && r.turnId === row.turnId,
    );
    for (
      let page = 0;
      !header && range.hasMore && range.rows.length && page < 50;
      page++
    ) {
      range = await this.rows(range.rows[0]!.rowId);
      if (range.atRevision !== revision || range.atLogEpoch !== epoch)
        return fail("History changed during file preview; retry.");
      header = range.rows.find(
        (r) => r.kind === "turnHeader" && r.turnId === row.turnId,
      );
    }
    if (!header?.entityId || header.actions?.canRewindFiles !== true)
      return fail("No native file-rewind checkpoint for this turn.");
    const target = { rowId: header.rowId, entityId: header.entityId };
    const result = record(
      await this.client.request("v4/conversation/fileRewindPreview", {
        sessionId: this.sessionId,
        target,
        baseRevision: range.atRevision,
        baseLogEpoch: range.atLogEpoch,
      }),
    );
    if (
      typeof result.canApply !== "boolean" ||
      !Array.isArray(result.safeFiles) ||
      !Array.isArray(result.unsafeFiles) ||
      !Array.isArray(result.ignoredFiles)
    )
      return fail("Invalid native file-rewind preview.");
    const details = JSON.stringify(result, null, 2);
    if (!result.canApply || result.unsafeFiles.length)
      return `${details}\nFile rewind is blocked by native safety checks.`;
    const id = `preview-${randomUUID()}`;
    this.preview = { id, range, target, expires: Date.now() + 5 * 60_000 };
    return `${details}\nTo apply this file-only rewind within five minutes: /zcode-file-rewind ${id}`;
  }
  async rewindFiles(id: string) {
    const preview = this.preview;
    this.preview = undefined;
    if (!preview || preview.id !== id || Date.now() > preview.expires)
      return fail(
        "Run /zcode-file-preview first, then use its session-specific preview token.",
      );
    const current = await this.rows();
    if (
      current.atRevision !== preview.range.atRevision ||
      current.atLogEpoch !== preview.range.atLogEpoch
    )
      return fail(
        "History changed after the preview. Preview again before rewinding files.",
      );
    const result = await this.command(
      "applyFileRewind",
      { target: preview.target },
      preview.range,
    );
    if (result.type !== "applyFileRewind" || result.applied !== true)
      return fail(
        "ZCode did not apply the file rewind. Preview again to inspect conflicts.",
      );
    return text(result.response, "ZCode file rewind applied.");
  }
  async fork(checkpoint?: string) {
    const { range, row } = await this.target(checkpoint);
    const result = await this.command(
      "forkAssistant",
      { target: { rowId: row.rowId, entityId: row.entityId } },
      range,
    );
    if (
      result.type !== "forkAssistant" ||
      typeof result.sessionId !== "string" ||
      !result.sessionId ||
      result.sessionId === this.sessionId
    )
      return fail("ZCode did not return a new fork session identity.");
    return result.sessionId;
  }
}

type Job = Record<string, unknown>;
export const managementCommands: Array<Record<string, string>> = [
  {
    name: "zcode-file-preview",
    description: "Preview native file rollback at a conversation checkpoint",
    inputHint: "[checkpoint-id]",
  },
  {
    name: "zcode-file-rewind",
    description:
      "Apply the previewed file-only rollback (Full Access required)",
    inputHint: "<preview-token>",
  },
  { name: "zcode-tasks", description: "List ZCode background work" },
  {
    name: "zcode-task-output",
    description: "Read bounded native background Bash output",
    inputHint: "<task-id>",
  },
  {
    name: "zcode-task-stop",
    description: "Cancel one native background task",
    inputHint: "<task-id>",
  },
  {
    name: "zcode-check",
    description:
      "Test native model connectivity with one real request (idle session)",
    inputHint: "[providerId/modelId]",
  },
  {
    name: "zcode-plugin",
    description:
      "Manage native ZCode plugins: list, install, update, uninstall, enable, disable, marketplace",
    inputHint: "<action> [args]",
  },
  {
    name: "zcode-automations",
    description: "List ZCode scheduled tasks with their next runs",
  },
  {
    name: "zcode-automation-delete",
    description: "Delete one ZCode scheduled task by id",
    inputHint: "<automation-id>",
  },
  {
    name: "zcode-offpeak",
    description: "List ZCode idle-time (off-peak) tasks with queue states",
  },
  {
    name: "zcode-offpeak-cancel",
    description: "Cancel one ZCode idle-time task by id",
    inputHint: "<task-id>",
  },
];
export class BackgroundWork {
  private jobs = new Map<
    string,
    { job: Job; item: DeltaItemShape; open: boolean }
  >();
  private timer?: ReturnType<typeof setTimeout>;
  private reading?: Promise<void>;
  private stopped = false;
  constructor(
    private client: ZCodeConnection,
    private sessionId: string,
    private emit: (deltas: ThreadDelta[]) => void,
  ) {}
  get active() {
    return [...this.jobs.values()].some((j) => j.open);
  }
  update(projection: unknown) {
    if (this.stopped) return;
    const raw = record(projection).backgroundJobs;
    if (!Array.isArray(raw)) return;
    for (const rawJob of raw.slice(0, 2048)) {
      const job = record(rawJob),
        id = text(job.taskId);
      if (!id) continue;
      const state = text(job.status);
      const pending = ["pending", "running", "paused"].includes(state);
      const status = pending
        ? "pending"
        : state === "completed"
          ? "completed"
          : ["cancelled", "stopped"].includes(state)
            ? "interrupted"
            : "failed";
      const summary = [
        text(job.outputTail),
        text(job.stdoutTail),
        text(job.stderrTail),
      ]
        .filter(Boolean)
        .join("\n")
        .slice(-8192);
      const item: DeltaItemShape =
        job.taskKind === "subagent"
          ? {
              type: "delegation",
              childRef: id,
              label: text(job.description, `ZCode agent ${id}`),
              background: true,
              ...(summary ? { summary } : {}),
            }
          : {
              type: "backgroundTask",
              familyId: this.sessionId,
              taskType: "zcode/bash",
              description: text(
                job.description,
                text(job.command, `ZCode task ${id}`),
              ).slice(0, 4000),
              skipTranscript: false,
              status,
              taskStatus: pending
                ? state === "paused"
                  ? "paused"
                  : "running"
                : status === "completed"
                  ? "completed"
                  : status === "interrupted"
                    ? "killed"
                    : "failed",
              ...(summary ? { summary } : {}),
              ...(job.outputPath ? { outputFile: text(job.outputPath) } : {}),
            };
      const previous = this.jobs.get(id),
        key = { providerItemId: `zcode-work-${id}` };
      if (previous && !previous.open) continue;
      if (!previous) this.emit([{ kind: "item.open", key, item }]);
      if (!pending && (!previous || previous.open))
        this.emit([{ kind: "item.close", key, item, status }]);
      else if (
        pending &&
        previous?.open &&
        JSON.stringify(previous.item) !== JSON.stringify(item)
      )
        this.emit([{ kind: "item.progress", key, snapshot: item }]);
      this.jobs.set(id, { job, item, open: pending });
    }
    // Keep completed deduplication bounded without evicting active work.
    for (const [id, entry] of this.jobs)
      if (this.jobs.size > 2048 && !entry.open) this.jobs.delete(id);
    this.schedule();
  }
  private schedule() {
    if (this.timer || this.stopped || !this.active) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh()
        .catch(() => {})
        .finally(() => this.schedule());
    }, 1000);
    this.timer.unref();
  }
  refresh() {
    if (this.stopped) return Promise.resolve();
    if (!this.reading)
      this.reading = this.client
        .request("session/read", { sessionId: this.sessionId })
        .then((raw) => {
          this.update(record(raw).projection);
        })
        .finally(() => {
          this.reading = undefined;
        });
    return this.reading;
  }
  close(status: "failed" | "interrupted") {
    this.stopped = true;
    clearTimeout(this.timer);
    for (const [id, entry] of this.jobs)
      if (entry.open) {
        const item =
          entry.item.type === "backgroundTask"
            ? {
                ...entry.item,
                status,
                taskStatus:
                  status === "failed"
                    ? ("failed" as const)
                    : ("killed" as const),
              }
            : entry.item;
        this.emit([
          {
            kind: "item.close",
            key: { providerItemId: `zcode-work-${id}` },
            item,
            status,
          },
        ]);
        entry.open = false;
      }
  }
  async manage(command: string, id: string) {
    // A read-only query negotiates the v4 control surface before any mutation.
    const history = new History(this.client, this.sessionId);
    await history.rows();
    await this.refresh();
    if (command === "zcode-tasks") {
      if (id) return fail("Usage: /zcode-tasks");
      return (
        [...this.jobs]
          .map(
            ([id, entry]) =>
              `${id}: ${text(entry.job.status)}${entry.job.cancellable === false ? " (not cancellable)" : ""} — ${text(entry.job.description, text(entry.job.command))}`,
          )
          .join("\n") || "No ZCode background tasks."
      );
    }
    const entry = this.jobs.get(id);
    if (!entry)
      return fail("Unknown ZCode task id in this session. Use /zcode-tasks.");
    if (command === "zcode-task-stop") {
      if (!entry.open || entry.job.cancellable === false)
        return fail("This ZCode task is finished or not cancellable.");
      await history.command("cancelBackgroundWork", { workId: id });
      await this.refresh();
      return `Cancellation requested for ${id}.`;
    }
    if (entry.job.taskKind === "subagent")
      return fail(
        "Native output retrieval supports Bash tasks; agent summaries appear on the task card.",
      );
    const result = record(
      await this.client.request("v4/conversation/backgroundBashOutput", {
        sessionId: this.sessionId,
        workId: id,
      }),
    );
    if (
      result.kind !== "output" ||
      result.workId !== id ||
      typeof result.output !== "string"
    )
      return fail(`ZCode task output is ${text(result.kind, "unavailable")}.`);
    return (
      result.output.slice(-8192) +
      (result.truncated ? "\n[Native output truncated]" : "")
    );
  }
  async cancelAll() {
    await this.refresh();
    for (const [id, entry] of this.jobs)
      if (entry.open)
        await new History(this.client, this.sessionId).command(
          "cancelBackgroundWork",
          { workId: id },
        );
  }
}
