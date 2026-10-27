import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createOffPeakServerClient,
  createOffPeakService,
  OffPeakServerError,
  type OffPeakServerClient,
} from "../src/offpeak.js";
import { createBridge } from "../src/bridge.js";
import { record } from "../src/protocol.js";
import type { ClientCallbacks } from "../src/client.js";
import type { AccountHost } from "../src/coding-plan.js";
import type { LaunchSpec } from "../src/launch.js";

const context = {
  threadId: "thread",
  providerThreadId: "native-1",
  cwd: "/workspace",
};

function fakeClient(options?: {
  takeTicketResult?: () => Promise<never>;
  /** Ticket states per takeTicket call, cycling the last entry. */
  states?: string[];
  batchResult?: (
    ticketIds: string[],
  ) => Promise<{ tickets: Array<{ ticketId: string; state: string }> }>;
}): OffPeakServerClient & {
  taken: string[];
  settled: string[];
  statuses: string[][];
} {
  const taken: string[] = [];
  const settled: string[] = [];
  const statuses: string[][] = [];
  const states = options?.states ?? ["queued"];
  return {
    taken,
    settled,
    statuses,
    async takeTicket(taskId: string) {
      taken.push(taskId);
      if (options?.takeTicketResult) return options.takeTicketResult();
      const state = states[Math.min(taken.length - 1, states.length - 1)];
      return {
        ticketId: `ticket-${taken.length}`,
        state: state as "queued",
        position: 4,
        registeredAt: Date.now(),
      };
    },
    async batchStatus(ticketIds: string[]) {
      statuses.push(ticketIds);
      if (options?.batchResult) {
        const result = await options.batchResult(ticketIds);
        return { nextPollAfterMs: 30_000, tickets: result.tickets as never };
      }
      return {
        nextPollAfterMs: 30_000,
        tickets: ticketIds.map((ticketId) => ({
          ticketId,
          state: "ready" as const,
        })),
      };
    },
    async settle(ticketId: string) {
      settled.push(ticketId);
    },
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bb-zcode-offpeak-"));
});
afterEach(() => {
  delete process.env.BB_BRIDGE_DIR;
});

// ---- Wire client shapes.

it("sends the ticket protocol with double auth and parses seconds", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = createOffPeakServerClient({
    resolveOrigin: () => "https://zcode.z.ai",
    resolveCredentials: async () => ({
      jwt: "jwt-token",
      codingPlanApiKey: "plan-key",
    }),
    fetchImpl: (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const path = String(url);
      if (path.endsWith("/ticket")) {
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({ task_id: "offpeak-x" });
        return new Response(
          JSON.stringify({
            ticket_id: "t-1",
            state: "queued",
            position: 0,
            next_poll_after: 30,
          }),
          { status: 200 },
        );
      }
      if (path.endsWith("/ticket/status")) {
        return new Response(
          JSON.stringify({
            next_poll_after: 45,
            tickets: [{ ticket_id: "t-1", state: "ready", position: null }],
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
  });
  const ticket = await client.takeTicket("offpeak-x");
  expect(ticket).toMatchObject({
    ticketId: "t-1",
    state: "queued",
    nextPollAfterMs: 30_000,
  });
  expect(ticket.position).toBe(1); // 0-based server position displayed 1-based
  const headers = calls[0]!.init.headers as Record<string, string>;
  expect(headers.authorization).toBe("Bearer jwt-token");
  expect(headers["x-coding-plan-api-key"]).toBe("plan-key");
  const status = await client.batchStatus(["t-1"]);
  expect(status.nextPollAfterMs).toBe(45_000);
  expect(status.tickets[0]).toMatchObject({ ticketId: "t-1", state: "ready" });
  expect(status.tickets[0].position).toBeUndefined();
});

it("maps gateway error bodies to typed errors with business codes", async () => {
  const client = createOffPeakServerClient({
    resolveOrigin: () => "https://zcode.z.ai",
    resolveCredentials: async () => ({
      jwt: "j",
      codingPlanApiKey: "k",
    }),
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({ code: 3103, msg: "quota", next_take_at: 123 }),
        {
          status: 429,
        },
      )) as typeof fetch,
  });
  await expect(client.takeTicket("x")).rejects.toMatchObject({
    bizCode: 3103,
    nextTakeAt: 123,
    name: "OffPeakServerError",
  });
  void OffPeakServerError;
});

// ---- Task service state machine.

it("creates a queued task with a taken ticket and classifies failures", async () => {
  const client = fakeClient();
  const s = createOffPeakService({ storeDir: dir, client });
  const created = record(
    await s.handle(
      "offPeak/create",
      { title: "Nightly report", prompt: "Write it", model: "glm-4.7" },
      context,
    ),
  );
  expect(created.ok).toBe(true);
  expect(client.taken).toHaveLength(1);
  const stored = JSON.parse(readFileSync(join(dir, "offpeak.json"), "utf8"));
  expect(stored.tasks[0].serverTicketId).toBe("ticket-1");
  expect(stored.tasks[0].status).toBe("queued");
  expect(stored.tasks[0].schedulable).toBe(false);
  // A second non-terminal task for the same bound session is refused before
  // taking a ticket (no quota burned).
  const second = record(
    await s.handle(
      "offPeak/create",
      { title: "Again", prompt: "x", model: "glm-4.7" },
      context,
    ),
  );
  expect(second).toMatchObject({
    ok: false,
    errorCode: "session_bound",
  });
  expect(client.taken).toHaveLength(1);
  // Gateway refusal classes map to the native error contract.
  const limited = createOffPeakService({
    storeDir: mkdtempSync(join(tmpdir(), "bb-zcode-offpeak-")),
    client: fakeClient({
      takeTicketResult: () =>
        Promise.reject(new OffPeakServerError("quota", 429, 3103, 999)),
    }),
  });
  const refused = record(
    await limited.handle(
      "offPeak/create",
      { title: "t", prompt: "p", model: "m" },
      context,
    ),
  );
  expect(refused).toMatchObject({
    ok: false,
    failureStage: "ticket_request",
    errorCategory: "quota_3103",
    errorCode: "3103",
  });
});

it("lists workspace-scoped tasks with the protocol snapshot shape", async () => {
  const client = fakeClient();
  const s = createOffPeakService({ storeDir: dir, client });
  await s.handle(
    "offPeak/create",
    { title: "A", prompt: "a", model: "m" },
    { ...context, cwd: "/ws-a" },
  );
  await s.handle(
    "offPeak/create",
    { title: "B", prompt: "b", model: "m" },
    { ...context, providerThreadId: "native-2", cwd: "/ws-b" },
  );
  const listA = record(
    await s.handle("offPeak/list", {}, { ...context, cwd: "/ws-a" }),
  ) as { tasks: Array<Record<string, unknown>> };
  expect(listA.tasks).toHaveLength(1);
  expect(listA.tasks[0].title).toBe("A");
  expect(listA.tasks[0].sessionId).toBeUndefined();
  expect(listA.tasks[0].queuePosition).toBe(4);
  await expect(s.handle("offPeak/list", {}, {})).rejects.toThrow(
    /No active bb session/,
  );
});

it("sync applies ready states, re-takes expired tickets and settles finals", async () => {
  const client = fakeClient({
    // First ticket expires, the retaken one becomes ready.
    states: ["queued", "ready"],
    batchResult: async (ticketIds) => ({
      tickets: ticketIds.map((ticketId) => ({
        ticketId,
        state: ticketId === "ticket-1" ? "expired" : "ready",
      })),
    }),
  });
  const s = createOffPeakService({ storeDir: dir, client });
  const created = record(
    await s.handle(
      "offPeak/create",
      { title: "t", prompt: "p", model: "m" },
      context,
    ),
  ) as unknown as { task: { offPeakTaskId: string } };
  const id = created.task.offPeakTaskId;
  await s.syncCycle();
  // expired ticket-1 was re-taken under the same task id.
  expect(client.taken).toEqual([id, id]);
  const afterRetake = await s.find(id);
  expect(afterRetake?.serverTicketId).toBe("ticket-2");
  expect(afterRetake?.schedulable).toBe(true);
  await s.completeRun(id, "completed");
  await s.syncCycle();
  // Terminal tasks settle their ticket through the outbox.
  expect(client.settled).toContain("ticket-2");
  expect((await s.find(id))?.status).toBe("completed");
});

it("a delayed status response for a replaced ticket cannot mark it schedulable", async () => {
  // The status poll for ticket-1 stalls in flight; while it is pending the
  // running task expires (3102) and completeRun requeues onto ticket-2.
  // Codex round 10: the delayed ticket-1 "ready" response used to flip the
  // replacement schedulable before the gateway granted it.
  let releaseStatus: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => (releaseStatus = resolve));
  const client = fakeClient({
    states: ["queued", "queued"],
    batchResult: async (ticketIds) => {
      await gate;
      return {
        tickets: ticketIds.map((ticketId) => ({
          ticketId,
          state: "ready" as const,
        })),
      };
    },
  });
  const s = createOffPeakService({ storeDir: dir, client });
  const created = record(
    await s.handle(
      "offPeak/create",
      { title: "t", prompt: "p", model: "m" },
      context,
    ),
  ) as unknown as { task: { offPeakTaskId: string } };
  const id = created.task.offPeakTaskId;
  const sync = s.syncCycle();
  // Wait until the poll is actually in flight, then expire the run so the
  // ticket is replaced while the response is pending.
  for (let i = 0; i < 200 && client.statuses.length === 0; i++)
    await new Promise((r) => setTimeout(r, 5));
  expect(client.statuses).toEqual([["ticket-1"]]);
  await s.completeRun(id, "ticketExpired", "window expired");
  releaseStatus!();
  await sync;
  const task = await s.find(id);
  expect(task?.serverTicketId).toBe("ticket-2");
  expect(task?.schedulable).toBe(false);
  // The stale response also must not have consumed another ticket.
  expect(client.taken).toEqual([id, id]);
});

it("ticket-expired outcomes requeue for continuation, failures stop after three", async () => {
  const client = fakeClient();
  const s = createOffPeakService({ storeDir: dir, client });
  const created = record(
    await s.handle(
      "offPeak/create",
      { title: "t", prompt: "p", model: "m" },
      context,
    ),
  ) as unknown as { task: { offPeakTaskId: string } };
  const id = created.task.offPeakTaskId;
  await s.completeRun(id, "ticketExpired", "window expired");
  let task = await s.find(id);
  expect(task?.status).toBe("queued");
  expect(task?.ranOnce).toBe(true);
  expect(task?.schedulable).toBe(false); // waits for the retaken ticket
  await s.completeRun(id, "failed", "boom");
  await s.completeRun(id, "failed", "boom");
  task = await s.find(id);
  expect(task?.status).toBe("queued");
  await s.completeRun(id, "failed", "boom");
  task = await s.find(id);
  expect(task?.status).toBe("failed");
  expect(task?.failureReason).toBe("boom");
  // Busy deferrals back off instead of failing.
  const other = record(
    await s.handle(
      "offPeak/create",
      { title: "u", prompt: "q", model: "m" },
      { ...context, providerThreadId: "native-2", cwd: "/ws-b" },
    ),
  ) as unknown as { task: { offPeakTaskId: string } };
  await s.completeRun(other.task.offPeakTaskId, "completed");
  void s.deferRun;
});

it("claims only ready queued tasks in FIFO order", async () => {
  const client = fakeClient();
  const s = createOffPeakService({ storeDir: dir, client });
  const first = record(
    await s.handle(
      "offPeak/create",
      { title: "first", prompt: "a", model: "m" },
      context,
    ),
  ) as unknown as { task: { offPeakTaskId: string } };
  const second = record(
    await s.handle(
      "offPeak/create",
      { title: "second", prompt: "b", model: "m" },
      { ...context, providerThreadId: "native-2", cwd: "/ws-b" },
    ),
  ) as unknown as { task: { offPeakTaskId: string } };
  await s.syncCycle(); // both tickets report ready
  const at = new Date();
  const claimed = s.due(at).map((t) => t.offPeakTaskId);
  expect(claimed).toEqual([
    first.task.offPeakTaskId,
    second.task.offPeakTaskId,
  ]);
  expect(s.beginRun(first.task.offPeakTaskId)).toBe(true);
  expect(s.beginRun(first.task.offPeakTaskId)).toBe(false);
});

// ---- Dispatch-level: the bridge runs a ready task through a synthetic peer.

function offPeakHarness(
  storeDir: string,
  completedResponse = "done",
  credentialsMode: "ok" | "throw" = "ok",
  attachBackgroundJob = false,
) {
  const cwd = mkdtempSync(join(tmpdir(), "bb-zcode-offpeak-bridge-"));
  const messages: Record<string, unknown>[] = [];
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const native = new Map<string, { cb?: ClientCallbacks; closed?: boolean }>();
  const accountStub = {
    async initialize() {},
    async authorize() {
      return { headersApplied: false };
    },
    close() {},
    async offPeakCredentials() {
      if (credentialsMode === "throw")
        throw new Error("cannot decrypt desktop sign-in");
      return {
        jwt: "bridge-jwt",
        codingPlanApiKey: "bridge-key",
        family: "zai" as const,
      };
    },
  };
  const client = fakeClient({ states: ["ready"] });
  const background = { job: undefined as Record<string, unknown> | undefined };
  let serial = 0,
    rid = 0,
    turnSerial = 0;
  const bridge = createBridge({
    write: (m) => messages.push(m),
    automationTickMs: 20,
    accountFactory: (() => accountStub) as unknown as (
      launch: LaunchSpec,
    ) => AccountHost,
    offPeakClientFactory: () => client,
    clientFactory: (_launch, _cwd, cb) => {
      let nativeId = "";
      const backgroundJob = () => background.job;
      const snapshot = () => ({
        session: { sessionId: nativeId },
        settings: {
          model: {
            current: { providerId: "test", modelId: "model" },
            available: [
              { ref: { providerId: "test", modelId: "model" }, label: "Model" },
            ],
          },
        },
        projection: {
          turnCount: 0,
          backgroundJobs: backgroundJob() ? [backgroundJob()] : [],
        },
      });
      return {
        async request(method: string, raw: unknown) {
          const p = record(raw);
          calls.push({ method, params: p });
          if (method === "session/create") {
            nativeId = `native-${++serial}`;
            native.set(nativeId, { cb });
            return snapshot();
          }
          if (method === "session/resume") {
            nativeId = String(p.sessionId);
            const existing = native.get(nativeId) ?? { cb: undefined };
            native.set(nativeId, existing);
            existing.cb = cb;
            existing.closed = false;
            return snapshot();
          }
          if (method === "session/read") return snapshot();
          if (method === "v4/conversation/rowsRange")
            return {
              rows: [],
              atSeq: 1,
              atRevision: 7,
              atLogEpoch: "epoch",
              hasMore: false,
            };
          if (method === "session/send") {
            const s = native.get(nativeId)!;
            if (p.offPeakTaskId !== undefined && attachBackgroundJob)
              background.job = {
                taskId: `bg-${p.offPeakTaskId}`,
                status: "running",
              };
            const turn = `turn-${++turnSerial}`;
            s.cb?.notification({
              method: "session/event",
              params: {
                sessionId: nativeId,
                type: "turn.started",
                eventSeq: turnSerial,
                turnId: turn,
                payload: {},
              },
            });
            setTimeout(
              () =>
                s.cb?.notification({
                  method: "session/event",
                  params: {
                    sessionId: nativeId,
                    type: "turn.completed",
                    eventSeq: turnSerial + 100,
                    turnId: turn,
                    payload: {
                      resultType: "success",
                      response: completedResponse,
                    },
                  },
                }),
              10,
            );
            return { accepted: true };
          }
          return {};
        },
        async close() {
          if (nativeId) native.get(nativeId)!.closed = true;
        },
      };
    },
  });
  async function until(check: () => boolean) {
    for (let i = 0; i < 1_000; i++) {
      if (check()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("Off-peak probe timed out");
  }
  async function rpc(method: string, params: unknown) {
    const id = ++rid;
    bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    await until(() => messages.some((m) => m.id === id && !m.method));
    return messages.find((m) => m.id === id && !m.method)!;
  }
  return {
    bridge,
    messages,
    calls,
    native,
    cwd,
    until,
    rpc,
    client,
    background,
  };
}

const offPeakOptions = {
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
  providerOptions: { executable: process.execPath, offPeakTasksEnabled: true },
};

it("dispatches a ready idle-time task with the idle-plan execution block", async () => {
  process.env.BB_BRIDGE_DIR = dir;
  const harness = offPeakHarness(dir);
  const { bridge, calls, native, cwd, until, rpc } = harness;
  await rpc("thread/start", {
    threadId: "thread",
    cwd,
    options: offPeakOptions,
    instructionMode: "replace",
  });
  const create = calls.find((c) => c.method === "session/create")!;
  expect(create.params.offPeakToolEnabled).toBe(true);
  const empty = await rpc("turn/start", {
    threadId: "thread",
    providerThreadId: "native-1",
    input: [{ type: "text", text: "/zcode-offpeak", mentions: [] }],
    options: offPeakOptions,
    clientRequestId: "creq_peakcmd992",
  });
  expect(JSON.stringify(empty) + JSON.stringify(harness.messages)).toContain(
    "No idle-time tasks",
  );
  // Create the task through the bridge's own reverse-RPC path so the
  // service, store and fake gateway all belong to the same instance.
  const created = record(
    await native.get("native-1")!.cb!.request("offPeak/create", {
      title: "Nightly",
      prompt: "Do the nightly work",
      model: "glm-4.7",
      permissionMode: "yolo",
    }),
  );
  expect(created.ok).toBe(true);
  // Release the thread so the dispatcher cold-resumes and owns the child.
  await rpc("thread/stop", {
    threadId: "thread",
    providerThreadId: "native-1",
    intent: "release",
    activeTurnId: null,
  });
  // The fake gateway hands a ready ticket: dispatch follows on the next tick.
  await until(() =>
    calls.some(
      (c) =>
        c.method === "session/send" && c.params.offPeakTaskId !== undefined,
    ),
  );
  const send = calls.find(
    (c) => c.method === "session/send" && c.params.offPeakTaskId !== undefined,
  )!;
  expect(send.params.offPeakRunType).toBe("init");
  expect(send.params.content).toContain("Do the nightly work");
  expect(send.params.toolDenylist).toEqual(["CronCreate", "OffPeakCreate"]);
  expect(record(send.params.modelSelection).providerId).toBe(
    "account:zai-offpeak-idle-plan",
  );
  const execution = record(send.params.modelExecution);
  expect(execution.selectionScope).toBe("execution");
  expect(execution.memoryExtraction).toBe("skip");
  expect(record(execution.offPeak).providerErrorCode).toBe("3102");
  expect(
    record(record(execution.requestAuth).headers)["X-Off-Peak-Ticket-ID"],
  ).toBe("ticket-1");
  expect(record(execution.requestAuth).apiKey).toBe("bridge-jwt");
  // The turn settles and the task completes; completeRun runs concurrently
  // with the child release, so wait for the persisted status itself.
  const readStore = () =>
    JSON.parse(readFileSync(join(dir, "offpeak.json"), "utf8")) as {
      tasks: Array<Record<string, unknown>>;
    };
  await until(() => readStore().tasks[0]?.status === "completed");
  expect(readStore().tasks[0].ranOnce).toBe(true);
  await bridge.close();
});

it("continues a task after a 3102 window expiry with the resume prompt", async () => {
  process.env.BB_BRIDGE_DIR = dir;
  const harness = offPeakHarness(dir);
  const { bridge, calls, native, cwd, until, rpc } = harness;
  await rpc("thread/start", {
    threadId: "thread",
    cwd,
    options: offPeakOptions,
    instructionMode: "replace",
  });
  const created = record(
    await native.get("native-1")!.cb!.request("offPeak/create", {
      title: "Nightly",
      prompt: "Do the nightly work",
      model: "glm-4.7",
    }),
  );
  expect(created.ok).toBe(true);
  await until(() =>
    calls.some(
      (c) => c.method === "session/send" && c.params.offPeakRunType === "init",
    ),
  );
  // Simulate the run failing on the window boundary.
  native.get("native-1")!.cb!.notification({
    method: "session/event",
    params: {
      sessionId: "native-1",
      type: "turn.failed",
      eventSeq: 500,
      turnId: "turn-1",
      payload: { error: { message: "provider rejected: 3102 ticket expired" } },
    },
  });
  // The task requeues and the next ready ticket continues the session.
  await until(() =>
    calls.some(
      (c) =>
        c.method === "session/send" && c.params.offPeakRunType === "resume",
    ),
  );
  const resume = calls.find(
    (c) => c.method === "session/send" && c.params.offPeakRunType === "resume",
  )!;
  expect(resume.params.content).toContain("Continue the previous task");
  await bridge.close();
});

// ---- Review-fix regressions (2026-10-24).

it("recovers an interrupted running task as a queued continuation", async () => {
  const client = fakeClient();
  const s = createOffPeakService({ storeDir: dir, client });
  const created = record(
    await s.handle(
      "offPeak/create",
      { title: "t", prompt: "p", model: "m" },
      context,
    ),
  ) as unknown as { task: { offPeakTaskId: string } };
  const id = created.task.offPeakTaskId;
  await s.beginRun(id);
  await s.markRunning(id);
  // Crash BEFORE the native side accepted the prompt: the retry must use
  // the original prompt, so ranOnce stays false.
  const preAdmission = createOffPeakService({
    storeDir: dir,
    client: fakeClient(),
  });
  await preAdmission.ready();
  expect((await preAdmission.find(id))?.ranOnce ?? false).toBe(false);
  // Crash AFTER acceptance: the retry continues the session instead.
  await preAdmission.beginRun(id);
  await preAdmission.markRunning(id);
  await preAdmission.markAdmitted(id);
  const reopened = createOffPeakService({
    storeDir: dir,
    client: fakeClient(),
  });
  await reopened.ready();
  const recovered = await reopened.find(id);
  expect(recovered?.status).toBe("queued");
  expect(recovered?.ranOnce).toBe(true); // next dispatch continues, not re-runs
  expect(recovered?.schedulable).toBe(false);
  // The claim died with the old instance; the reopened one can claim.
  expect(reopened.beginRun(id)).toBe(true);
});

it("retryRun releases a claim so the next tick can dispatch again", async () => {
  const s = createOffPeakService({ storeDir: dir, client: fakeClient() });
  const created = record(
    await s.handle(
      "offPeak/create",
      { title: "t", prompt: "p", model: "m" },
      context,
    ),
  ) as unknown as { task: { offPeakTaskId: string } };
  const id = created.task.offPeakTaskId;
  expect(s.beginRun(id)).toBe(true);
  s.retryRun(id);
  expect(s.beginRun(id)).toBe(true);
});

it("retakes tickets the gateway reports as not_found", async () => {
  const client = fakeClient({
    states: ["queued", "ready"],
    batchResult: async (ticketIds) => ({
      tickets: ticketIds.map((ticketId) => ({
        ticketId,
        state: ticketId === "ticket-1" ? "not_found" : "ready",
      })),
    }),
  });
  const s = createOffPeakService({ storeDir: dir, client });
  const created = record(
    await s.handle(
      "offPeak/create",
      { title: "t", prompt: "p", model: "m" },
      context,
    ),
  ) as unknown as { task: { offPeakTaskId: string } };
  await s.syncCycle();
  const task = await s.find(created.task.offPeakTaskId);
  expect(client.taken).toHaveLength(2);
  expect(task?.serverTicketId).toBe("ticket-2");
  expect(task?.schedulable).toBe(true);
});

it("completes a task whose successful reply merely mentions 3102", async () => {
  process.env.BB_BRIDGE_DIR = dir;
  const harness = offPeakHarness(
    dir,
    "Fixed issue 3102 and ticket 31020 today",
  );
  const { bridge, calls, native, cwd, until, rpc } = harness;
  await rpc("thread/start", {
    threadId: "thread",
    cwd,
    options: offPeakOptions,
    instructionMode: "replace",
  });
  const created = record(
    await native.get("native-1")!.cb!.request("offPeak/create", {
      title: "Nightly",
      prompt: "Do the nightly work",
      model: "glm-4.7",
    }),
  );
  expect(created.ok).toBe(true);
  await until(() =>
    calls.some(
      (c) =>
        c.method === "session/send" && c.params.offPeakTaskId !== undefined,
    ),
  );
  const readStore = () =>
    JSON.parse(readFileSync(join(dir, "offpeak.json"), "utf8")) as {
      tasks: Array<Record<string, unknown>>;
    };
  await until(() => readStore().tasks[0]?.status === "completed");
  // No continuation was queued: exactly one off-peak send happened.
  expect(
    calls.filter(
      (c) =>
        c.method === "session/send" && c.params.offPeakTaskId !== undefined,
    ),
  ).toHaveLength(1);
  await bridge.close();
});

it("busy deferrals back off from 30s and never burn failure strikes", async () => {
  const fixed = new Date("2026-10-24T12:00:00Z");
  const s = createOffPeakService({
    storeDir: dir,
    client: fakeClient(),
    now: () => fixed,
  });
  const created = record(
    await s.handle(
      "offPeak/create",
      { title: "t", prompt: "p", model: "m" },
      context,
    ),
  ) as unknown as { task: { offPeakTaskId: string } };
  const id = created.task.offPeakTaskId;
  await s.deferRun(id);
  let task = await s.find(id);
  expect(task?.nextDispatchAt).toBe(fixed.getTime() + 30_000);
  await s.deferRun(id);
  task = await s.find(id);
  expect(task?.nextDispatchAt).toBe(fixed.getTime() + 60_000);
  // Two deferrals plus two run failures stay short of the three-strike
  // limit; only the third real failure fails the task.
  await s.completeRun(id, "failed", "boom");
  await s.completeRun(id, "failed", "boom");
  task = await s.find(id);
  expect(task?.status).toBe("queued");
  await s.completeRun(id, "failed", "boom");
  task = await s.find(id);
  expect(task?.status).toBe("failed");
});

it("fails a task when reading credentials throws instead of stranding the claim", async () => {
  process.env.BB_BRIDGE_DIR = dir;
  const harness = offPeakHarness(dir, "done", "throw");
  const { bridge, calls, native, cwd, until, rpc } = harness;
  await rpc("thread/start", {
    threadId: "thread",
    cwd,
    options: offPeakOptions,
    instructionMode: "replace",
  });
  const created = record(
    await native.get("native-1")!.cb!.request("offPeak/create", {
      title: "Nightly",
      prompt: "Do the nightly work",
      model: "glm-4.7",
    }),
  );
  expect(created.ok).toBe(true);
  const readStore = () =>
    JSON.parse(readFileSync(join(dir, "offpeak.json"), "utf8")) as {
      tasks: Array<Record<string, unknown>>;
    };
  await until(() => readStore().tasks[0]?.status === "failed");
  expect(String(readStore().tasks[0].failureReason)).toContain(
    "credentials unavailable",
  );
  // No prompt ever left and the claim was released, not stranded.
  expect(
    calls.some((c) => c.method === "session/send" && c.params.offPeakTaskId),
  ).toBe(false);
  await bridge.close();
});

// ---- Review round 3: create race, rejected creations, cancel-during-dispatch.

it("rejects concurrent duplicate creates for one bound session before tickets", async () => {
  const client = fakeClient();
  const s = createOffPeakService({ storeDir: dir, client });
  const [first, second] = (await Promise.all([
    s.handle(
      "offPeak/create",
      { title: "A", prompt: "a", model: "m" },
      context,
    ),
    s.handle(
      "offPeak/create",
      { title: "B", prompt: "b", model: "m" },
      context,
    ),
  ])) as Array<Record<string, unknown>>;
  expect(first.ok).toBe(true);
  expect(second).toMatchObject({ ok: false, errorCode: "session_bound" });
  // The rejected duplicate never took a ticket.
  expect(client.taken).toHaveLength(1);
});

it("a cancelled task stays cancelled when dispatch markers arrive late", async () => {
  const client = fakeClient();
  const s = createOffPeakService({ storeDir: dir, client });
  const created = record(
    await s.handle(
      "offPeak/create",
      { title: "t", prompt: "p", model: "m" },
      context,
    ),
  ) as unknown as { task: { offPeakTaskId: string } };
  const id = created.task.offPeakTaskId;
  expect(await s.cancel(id, context.cwd)).toBe(true);
  // The dispatcher was already past its snapshot when the cancel landed:
  // both markers report false so the dispatcher never sends the prompt.
  expect(await s.markRunning(id)).toBe(false);
  expect(await s.markAdmitted(id)).toBe(false);
  await s.deferRun(id);
  const task = await s.find(id);
  expect(task?.status).toBe("cancelled");
  expect(s.due(new Date(Date.now() + 86_400_000))).toHaveLength(0);
});

it("a creation whose persistence fails never becomes dispatchable", async () => {
  const dir2 = mkdtempSync(join(tmpdir(), "bb-zcode-offpeak-persist-"));
  const client = fakeClient();
  const s = createOffPeakService({ storeDir: dir2, client });
  // First create succeeds so the store loads and the file exists.
  await s.handle(
    "offPeak/create",
    { title: "seed", prompt: "p", model: "m" },
    { ...context, providerThreadId: "native-seed", cwd: "/ws-seed" },
  );
  // Deterministic failure on every platform: replace the store file with a
  // directory so persist's tmp-file rename onto it fails.
  const { rmSync, mkdirSync } = await import("node:fs");
  rmSync(join(dir2, "offpeak.json"));
  mkdirSync(join(dir2, "offpeak.json"));
  const result = record(
    await s.handle(
      "offPeak/create",
      { title: "t", prompt: "p", model: "m" },
      context,
    ),
  );
  expect(result).toMatchObject({
    ok: false,
    failureStage: "local_persist",
  });
  // The rejected entry is gone from the in-memory list: nothing to claim.
  const listed = record(await s.handle("offPeak/list", {}, context)) as {
    tasks: unknown[];
  };
  expect(listed.tasks).toHaveLength(0);
});

it("rolls the in-memory state back when a marker write fails", async () => {
  const dir2 = mkdtempSync(join(tmpdir(), "bb-zcode-offpeak-marker-"));
  const s = createOffPeakService({ storeDir: dir2, client: fakeClient() });
  const created = record(
    await s.handle(
      "offPeak/create",
      { title: "t", prompt: "p", model: "m" },
      context,
    ),
  ) as unknown as { task: { offPeakTaskId: string } };
  const id = created.task.offPeakTaskId;
  // Break persistence like the rejected-creation test, then attempt both
  // markers: each returns false and leaves the task exactly as it was.
  const { rmSync, mkdirSync } = await import("node:fs");
  rmSync(join(dir2, "offpeak.json"));
  mkdirSync(join(dir2, "offpeak.json"));
  expect(await s.markRunning(id)).toBe(false);
  let task = await s.find(id);
  expect(task?.status).toBe("queued"); // not stranded as in-memory running
  expect(await s.markAdmitted(id)).toBe(false);
  task = await s.find(id);
  expect(task?.ranOnce ?? false).toBe(false);
  // The claim can be taken again after the bridge's retryRun release.
  expect(s.beginRun(id)).toBe(true);
});

it("polls ticket status in gateway-sized batches and preserves concurrent cancels on rollback", async () => {
  const client = fakeClient();
  const s = createOffPeakService({ storeDir: dir, client });
  // 110 active tickets: the gateway caps batches at 100 ticket_ids.
  for (let i = 0; i < 110; i += 1)
    await s.handle(
      "offPeak/create",
      { title: `t${i}`, prompt: "p", model: "m" },
      { ...context, providerThreadId: `native-${i}`, cwd: `/ws-${i % 2}` },
    );
  await s.syncCycle();
  expect(client.statuses).toHaveLength(2);
  expect(client.statuses[0]).toHaveLength(100);
  expect(client.statuses[1]).toHaveLength(10);
  // Chunk-scoped application: no cross-chunk misses, so no spurious
  // retakes of healthy tickets after the two-batch poll.
  expect(client.taken).toHaveLength(110);
  // Rollback vs concurrent cancel: break persistence, cancel a task (its
  // own write also fails, leaving cancelled in memory), then a late
  // markRunning must not resurrect it through the rollback path.
  const { rmSync, mkdirSync } = await import("node:fs");
  rmSync(join(dir, "offpeak.json"));
  mkdirSync(join(dir, "offpeak.json"));
  const cancelled = await s.find(
    (
      record(
        await s.handle("offPeak/list", {}, { ...context, cwd: "/ws-0" }),
      ) as {
        tasks: Array<{ offPeakTaskId: string }>;
      }
    ).tasks[0].offPeakTaskId,
  );
  expect(cancelled).toBeDefined();
  // cancel's own durable write fails too (broken store); it still leaves
  // the task cancelled in memory and rejects - swallow that here.
  await s.cancel(cancelled!.offPeakTaskId, "/ws-0").catch(() => undefined);
  expect(await s.markRunning(cancelled!.offPeakTaskId)).toBe(false);
  expect((await s.find(cancelled!.offPeakTaskId))?.status).toBe("cancelled");
});

it("does not send a task into a thread that was rebound to another session", async () => {
  process.env.BB_BRIDGE_DIR = dir;
  const harness = offPeakHarness(dir);
  const { bridge, calls, native, cwd, until, rpc } = harness;
  await rpc("thread/start", {
    threadId: "thread",
    cwd,
    options: offPeakOptions,
    instructionMode: "replace",
  });
  const created = record(
    await native.get("native-1")!.cb!.request("offPeak/create", {
      title: "Nightly",
      prompt: "Do the nightly work",
      model: "glm-4.7",
    }),
  );
  expect(created.ok).toBe(true);
  // Rebind the thread to a different native session (fork-style resume).
  await rpc("thread/resume", {
    threadId: "thread",
    cwd,
    providerThreadId: "native-9",
    options: offPeakOptions,
    instructionMode: "replace",
    dynamicTools: [],
  });
  const readStore = () =>
    JSON.parse(readFileSync(join(dir, "offpeak.json"), "utf8")) as {
      tasks: Array<Record<string, unknown>>;
    };
  await until(() => readStore().tasks[0]?.status === "failed");
  expect(String(readStore().tasks[0].failureReason)).toContain(
    "no longer backs this task's session",
  );
  expect(
    calls.some(
      (c) =>
        c.method === "session/send" && c.params.offPeakTaskId !== undefined,
    ),
  ).toBe(false);
  await bridge.close();
});

it("keeps the dispatcher-owned child alive while a run's background work is active", async () => {
  process.env.BB_BRIDGE_DIR = dir;
  const harness = offPeakHarness(dir, "done", "ok", true);
  const { bridge, calls, native, cwd, until, rpc } = harness;
  // The fake snapshot gains a running background job after the off-peak
  // prompt is accepted, so finishTurn sees active background work.
  await rpc("thread/start", {
    threadId: "thread",
    cwd,
    options: offPeakOptions,
    instructionMode: "replace",
  });
  const created = record(
    await native.get("native-1")!.cb!.request("offPeak/create", {
      title: "Nightly",
      prompt: "Do the nightly work",
      model: "glm-4.7",
    }),
  );
  expect(created.ok).toBe(true);
  // Release the thread so the dispatcher owns the child.
  await rpc("thread/stop", {
    threadId: "thread",
    providerThreadId: "native-1",
    intent: "release",
    activeTurnId: null,
  });
  await until(() =>
    calls.some(
      (c) => c.method === "session/send" && c.params.offPeakRunType === "init",
    ),
  );
  const readStore = () =>
    JSON.parse(readFileSync(join(dir, "offpeak.json"), "utf8")) as {
      tasks: Array<Record<string, unknown>>;
    };
  await until(() => readStore().tasks[0]?.status === "completed");
  // The child was NOT closed at settle: session/read still reports the
  // running background job the fake attached to the off-peak turn.
  // (The fake marks closed only on client.close; assert it is still open.)
  expect(native.get("native-1")!.closed ?? false).toBe(false);
  await bridge.close();
});

it("dispatches a /compact prompt natively instead of compacting without the ticket", async () => {
  process.env.BB_BRIDGE_DIR = dir;
  const harness = offPeakHarness(dir);
  const { bridge, calls, native, cwd, until, rpc } = harness;
  await rpc("thread/start", {
    threadId: "thread",
    cwd,
    options: offPeakOptions,
    instructionMode: "replace",
  });
  // An initial prompt of exactly "/compact" used to select the native
  // session/compact branch, dropping the off-peak payload (ticket auth,
  // idle-plan model, task identity) while dispatch persisted admission.
  const created = record(
    await native.get("native-1")!.cb!.request("offPeak/create", {
      title: "Compactor",
      prompt: "/compact",
      model: "glm-4.7",
      permissionMode: "yolo",
    }),
  );
  expect(created.ok).toBe(true);
  await rpc("thread/stop", {
    threadId: "thread",
    providerThreadId: "native-1",
    intent: "release",
    activeTurnId: null,
  });
  await until(() =>
    calls.some(
      (c) =>
        c.method === "session/send" && c.params.offPeakTaskId !== undefined,
    ),
  );
  const send = calls.find(
    (c) => c.method === "session/send" && c.params.offPeakTaskId !== undefined,
  )!;
  expect(send.params.content).toContain("/compact");
  expect(record(send.params.modelExecution).offPeak).toBeDefined();
  expect(
    calls.some(
      (c) =>
        c.method === "session/compact" && c.params.offPeakTaskId !== undefined,
    ),
  ).toBe(false);
  const readStore = () =>
    JSON.parse(readFileSync(join(dir, "offpeak.json"), "utf8")) as {
      tasks: Array<Record<string, unknown>>;
    };
  await until(() => readStore().tasks[0]?.status === "completed");
  await bridge.close();
});

it("dispatches a management-command prompt natively instead of intercepting it", async () => {
  process.env.BB_BRIDGE_DIR = dir;
  const harness = offPeakHarness(dir);
  const { bridge, calls, native, cwd, until, rpc } = harness;
  await rpc("thread/start", {
    threadId: "thread",
    cwd,
    options: offPeakOptions,
    instructionMode: "replace",
  });
  // The task prompt is a plugin management command. Local interception would
  // finish a standalone timeline without a native turn while dispatch has
  // already persisted admission - stranding the run and its concurrency slot.
  const created = record(
    await native.get("native-1")!.cb!.request("offPeak/create", {
      title: "Reporter",
      prompt: "/zcode-tasks",
      model: "glm-4.7",
      permissionMode: "yolo",
    }),
  );
  expect(created.ok).toBe(true);
  await rpc("thread/stop", {
    threadId: "thread",
    providerThreadId: "native-1",
    intent: "release",
    activeTurnId: null,
  });
  await until(() =>
    calls.some(
      (c) =>
        c.method === "session/send" && c.params.offPeakTaskId !== undefined,
    ),
  );
  const send = calls.find(
    (c) => c.method === "session/send" && c.params.offPeakTaskId !== undefined,
  )!;
  expect(send.params.content).toContain("/zcode-tasks");
  const readStore = () =>
    JSON.parse(readFileSync(join(dir, "offpeak.json"), "utf8")) as {
      tasks: Array<Record<string, unknown>>;
    };
  await until(() => readStore().tasks[0]?.status === "completed");
  await bridge.close();
});

// ---- Review round 9: cold-dispatch rebind, background settle release, single-flight retake.

it("fails a cold dispatch when the thread was rebound and released", async () => {
  process.env.BB_BRIDGE_DIR = dir;
  const harness = offPeakHarness(dir);
  const { bridge, calls, native, cwd, until, rpc } = harness;
  await rpc("thread/start", {
    threadId: "thread",
    cwd,
    options: offPeakOptions,
    instructionMode: "replace",
  });
  const created = record(
    await native.get("native-1")!.cb!.request("offPeak/create", {
      title: "Nightly",
      prompt: "Do the nightly work",
      model: "glm-4.7",
    }),
  );
  expect(created.ok).toBe(true);
  // Rebind the thread to a new native session, then release everything:
  // the cold dispatcher must not resume the task's old native session.
  await rpc("thread/resume", {
    threadId: "thread",
    cwd,
    providerThreadId: "native-9",
    options: offPeakOptions,
    instructionMode: "replace",
    dynamicTools: [],
  });
  await rpc("thread/stop", {
    threadId: "thread",
    providerThreadId: "native-9",
    intent: "release",
    activeTurnId: null,
  });
  const readStore = () =>
    JSON.parse(readFileSync(join(dir, "offpeak.json"), "utf8")) as {
      tasks: Array<Record<string, unknown>>;
    };
  await until(() => readStore().tasks[0]?.status === "failed");
  expect(String(readStore().tasks[0].failureReason)).toContain(
    "no longer backs this task's session",
  );
  expect(
    calls.some(
      (c) => c.method === "session/resume" && c.params.sessionId === "native-1",
    ),
  ).toBe(false);
  await bridge.close();
});

it("releases a dispatcher-owned child once its background work settles", async () => {
  process.env.BB_BRIDGE_DIR = dir;
  const harness = offPeakHarness(dir, "done", "ok", true);
  const { bridge, calls, native, cwd, until, rpc, background } = harness;
  await rpc("thread/start", {
    threadId: "thread",
    cwd,
    options: offPeakOptions,
    instructionMode: "replace",
  });
  const created = record(
    await native.get("native-1")!.cb!.request("offPeak/create", {
      title: "Nightly",
      prompt: "Do the nightly work",
      model: "glm-4.7",
    }),
  );
  expect(created.ok).toBe(true);
  await rpc("thread/stop", {
    threadId: "thread",
    providerThreadId: "native-1",
    intent: "release",
    activeTurnId: null,
  });
  await until(() =>
    calls.some(
      (c) => c.method === "session/send" && c.params.offPeakRunType === "init",
    ),
  );
  const readStore = () =>
    JSON.parse(readFileSync(join(dir, "offpeak.json"), "utf8")) as {
      tasks: Array<Record<string, unknown>>;
    };
  await until(() => readStore().tasks[0]?.status === "completed");
  // Turn settled while the background job was still running: child alive.
  expect(native.get("native-1")!.closed ?? false).toBe(false);
  // The background work finishes and the native CLI pushes state; the
  // owned child is released by the background-settle hook.
  background.job = {
    ...(background.job as Record<string, unknown>),
    status: "completed",
  };
  native.get("native-1")!.cb!.notification({
    method: "state.updated",
    params: { sessionId: "native-1" },
  });
  await until(() => native.get("native-1")!.closed === true);
  await bridge.close();
});

it("retakes are single-flight: a concurrent status poll cannot take a second ticket", async () => {
  const client = fakeClient({
    states: ["queued", "ready"],
    batchResult: async (ticketIds) => ({
      tickets: ticketIds.map((ticketId) => ({
        ticketId,
        state: ticketId === "ticket-1" ? "expired" : "queued",
      })),
    }),
  });
  const realTake = client.takeTicket.bind(client);
  // Gate only the SECOND take (the retake) with a controllable promise.
  let gate: Promise<void> | undefined;
  let openGate: (() => void) | undefined;
  let takes = 0;
  client.takeTicket = async (taskId: string) => {
    takes += 1;
    if (takes === 2 && gate) await gate;
    return realTake(taskId);
  };
  const s = createOffPeakService({ storeDir: dir, client });
  const created = record(
    await s.handle(
      "offPeak/create",
      { title: "t", prompt: "p", model: "m" },
      context,
    ),
  ) as unknown as { task: { offPeakTaskId: string } };
  const id = created.task.offPeakTaskId;
  gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  // Path A: a 3102 expiry triggers a retake that parks on the gate.
  const expiry = s.completeRun(id, "ticketExpired", "window expired");
  await new Promise((r) => setTimeout(r, 20));
  // Path B: a concurrent sync poll sees the OLD ticket expired and also
  // wants to retake - single-flight must skip it.
  await s.syncCycle();
  openGate!();
  await expiry;
  expect(client.taken).toEqual([id, id]); // exactly one retake
  const task = await s.find(id);
  expect(task?.serverTicketId).toBe("ticket-2");
});
