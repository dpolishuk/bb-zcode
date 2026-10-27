import { homedir } from "node:os";
import { z } from "zod";
import type { ZCodeConnection } from "./client.js";
import { ZCodeClient } from "./client.js";
import { resolveLaunch, workspaceRef, type LaunchOptions } from "./launch.js";
import { record } from "./protocol.js";
import { workflowRunViewSchema, type WorkflowRunView } from "./runsContract.js";

/**
 * Cross-process run reads for the bb-side surfaces (thread run pane, sidebar
 * hub). `workflows/runs` is served from the persisted journal store, so a
 * short-lived sessionless CLI process can read any workspace's history - the
 * original thread's session is not needed (POC-verified cold read).
 */

const runRowSchema = z.looseObject({
  runId: z.string(),
  name: z.string().optional(),
  status: z.enum(["pending", "running", "completed", "errored", "stopped"]),
  stopReason: z.string().optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
  spentTokens: z.number().optional(),
  parentSessionId: z.string().optional(),
  toolCallId: z.string().optional(),
  cwd: z.string().optional(),
  artifacts: z
    .array(
      z.looseObject({
        id: z.string(),
        kind: z.string(),
        title: z.string().optional(),
      }),
    )
    .optional(),
});
export type WorkflowRunRow = z.infer<typeof runRowSchema>;

const runsReplySchema = z.looseObject({
  runs: z.array(runRowSchema),
  truncated: z.boolean().optional(),
});

export interface WorkflowRunsSnapshot {
  runs: WorkflowRunRow[];
  truncated: boolean;
}

/**
 * One spawn per call is the honest cost of a cold read; callers that poll
 * should serialize through `WorkflowRunsReader` instead. The connection is
 * injectable so tests can drive the wire shapes without a real CLI.
 */
export async function readWorkflowRunsFrom(
  connect: () => ZCodeConnection,
  cwd: string,
  limit = 50,
): Promise<WorkflowRunsSnapshot> {
  const client = connect();
  try {
    const reply = runsReplySchema.parse(
      await client.request(
        "workflows/runs",
        { workspace: workspaceRef(cwd), limit },
        20_000,
      ),
    );
    return { runs: reply.runs ?? [], truncated: reply.truncated === true };
  } finally {
    await client.close();
  }
}

export async function readWorkflowRuns(
  options: LaunchOptions,
  env: NodeJS.ProcessEnv,
  cwd: string,
  limit = 50,
): Promise<WorkflowRunsSnapshot> {
  const launch = resolveLaunch(options, env);
  return readWorkflowRunsFrom(
    () =>
      new ZCodeClient(
        launch,
        cwd,
        {
          notification() {},
          // A sessionless store read has no turn to anchor host requests; the
          // CLI only needs the reply shape, and a denial keeps it moving.
          // Must reject asynchronously: a synchronous throw escapes the
          // transport's stdout handler instead of becoming the reply.
          request: async (method) => {
            throw new Error(`Sessionless run read cannot answer ${method}.`);
          },
          exit() {},
        },
        null,
      ),
    cwd,
    limit,
  );
}

/**
 * Single-flight plus short TTL so pane and hub refreshes share one spawn.
 * Both are keyed by workspace and limit: one reader serves many projects,
 * and a cached large-limit page must not answer a smaller request.
 */
export class WorkflowRunsReader {
  private static CACHE_SLOTS = 8;
  private inflight = new Map<string, Promise<WorkflowRunsSnapshot>>();
  private cached = new Map<
    string,
    { at: number; value: WorkflowRunsSnapshot }
  >();
  constructor(
    private spawn: (
      cwd: string,
      limit: number,
    ) => Promise<WorkflowRunsSnapshot> = (cwd, limit) =>
      readWorkflowRuns(this.options(), this.env, cwd, limit),
    private options: () => LaunchOptions = () => ({
      executable: "",
      args: [],
      nodeExecutable: "node",
    }),
    private env: NodeJS.ProcessEnv = process.env,
    private ttlMs = 3000,
  ) {}
  read(
    cwd = homedir(),
    limit = 50,
    force = false,
  ): Promise<WorkflowRunsSnapshot> {
    const key = `${limit}:${cwd}`;
    if (!force) {
      const hit = this.cached.get(key);
      if (hit && Date.now() - hit.at < this.ttlMs)
        return Promise.resolve(hit.value);
    }
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const flight = this.spawn(cwd, limit)
      .then((value) => {
        if (this.cached.size >= WorkflowRunsReader.CACHE_SLOTS) {
          const oldest = [...this.cached.entries()].sort(
            (a, b) => a[1].at - b[1].at,
          )[0];
          if (oldest) this.cached.delete(oldest[0]);
        }
        this.cached.set(key, { at: Date.now(), value });
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, flight);
    return flight;
  }
}

/** Normalized projection the frontend renders; unknowns stay undefined. */
export function runRowView(row: WorkflowRunRow): WorkflowRunView {
  return workflowRunViewSchema.parse({
    runId: row.runId,
    ...(row.name ? { name: row.name } : {}),
    status: row.status,
    ...(row.stopReason ? { stopReason: row.stopReason } : {}),
    ...(typeof row.createdAt === "number" ? { createdAt: row.createdAt } : {}),
    ...(typeof row.updatedAt === "number" ? { updatedAt: row.updatedAt } : {}),
    ...(typeof row.spentTokens === "number"
      ? { spentTokens: row.spentTokens }
      : {}),
    ...(row.parentSessionId ? { parentSessionId: row.parentSessionId } : {}),
    ...(row.toolCallId ? { toolCallId: row.toolCallId } : {}),
    ...(Array.isArray(row.artifacts)
      ? {
          artifacts: row.artifacts.slice(0, 8).map((a) => ({
            id: String(record(a).id ?? ""),
            kind: String(record(a).kind ?? "file"),
            ...(typeof record(a).title === "string"
              ? { title: record(a).title as string }
              : {}),
          })),
        }
      : {}),
  });
}
