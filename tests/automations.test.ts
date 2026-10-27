import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createAutomationService } from "../src/automations.js";
import { createBridge } from "../src/bridge.js";
import { record } from "../src/protocol.js";
import type { ClientCallbacks } from "../src/client.js";

const context = {
  threadId: "thread",
  providerThreadId: "native-1",
  cwd: "/workspace",
};

function service(dir: string, now: () => Date = () => new Date()) {
  return createAutomationService({ storeDir: dir, now });
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bb-zcode-automations-"));
});
afterEach(() => {
  delete process.env.BB_BRIDGE_DIR;
});

it("creates a cron automation with the protocol snapshot shape", async () => {
  const fixed = new Date("2026-10-23T10:00:00Z");
  const s = service(dir, () => fixed);
  const result = record(
    await s.handle(
      "automation/create",
      {
        cronExpr: "0 9 * * *",
        prompt: "Run the report",
        title: "Report",
        targetTaskId: "native-1",
      },
      context,
    ),
  ) as { automation: Record<string, unknown> };
  const automation = result.automation;
  expect(automation.lifecycleStatus).toBe("active");
  expect(automation.recurring).toBe(true);
  expect(automation.runCount).toBe(0);
  expect(automation.enabled).toBe(true);
  expect(automation.targetTaskId).toBe("native-1");
  // Cron schedules follow the machine's local timezone, like the native host.
  expect(new Date(Number(automation.nextRunAt)).getHours()).toBe(9);
  // The strict protocol snapshot must not leak host-private fields.
  expect(automation.threadId).toBeUndefined();
  expect(automation.workspacePath).toBeUndefined();
  const stored = JSON.parse(
    readFileSync(join(dir, "automations.json"), "utf8"),
  );
  expect(stored.automations).toHaveLength(1);
  expect(stored.automations[0].threadId).toBe("thread");
});

it("derives title from the prompt and stores relative one-shots", async () => {
  const fixed = new Date("2026-10-23T10:00:00Z");
  const s = service(dir, () => fixed);
  const created = record(
    await s.handle(
      "automation/create",
      {
        cronExpr: "* * * * *",
        relativeDelayMinutes: 30,
        prompt: "Check the build later",
      },
      context,
    ),
  ) as { automation: Record<string, unknown> };
  expect(created.automation.title).toBe("Check the build later");
  expect(created.automation.recurring).toBe(false);
  expect(created.automation.nextRunAt).toBe(fixed.getTime() + 30 * 60_000);
});

it("normalizes interval carriers into a schedule rule", async () => {
  const fixed = new Date("2026-10-23T10:04:00Z");
  const s = service(dir, () => fixed);
  const created = record(
    await s.handle(
      "automation/create",
      {
        cronExpr: "0 * * * *",
        intervalUnit: "hourly",
        interval: 2,
        prompt: "Every two hours",
      },
      context,
    ),
  ) as { automation: Record<string, unknown> };
  expect(created.automation.recurring).toBe(true);
  expect(created.automation.maxRuns).toBeUndefined();
  const rule = record(created.automation.scheduleRule);
  expect(rule.unit).toBe("hourly");
  expect(rule.interval).toBe(2);
  expect(created.automation.nextRunAt).toBe(fixed.getTime() + 2 * 3_600_000);
});

it("rejects a second automation for the same session", async () => {
  const s = service(dir);
  await s.handle(
    "automation/create",
    {
      cronExpr: "0 9 * * *",
      prompt: "first",
    },
    context,
  );
  await expect(
    s.handle(
      "automation/create",
      { cronExpr: "0 9 * * *", prompt: "second" },
      context,
    ),
  ).rejects.toThrow(/already belongs to a scheduled task/);
});

it("enforces the upstream create limit with its error token", async () => {
  const s = service(dir);
  for (let i = 0; i < 20; i += 1)
    await s.handle(
      "automation/create",
      {
        cronExpr: "0 9 * * *",
        prompt: `task ${i}`,
      },
      { ...context, providerThreadId: `native-${i}` },
    );
  await expect(
    s.handle(
      "automation/create",
      { cronExpr: "0 9 * * *", prompt: "extra" },
      {
        ...context,
        providerThreadId: "native-extra",
      },
    ),
  ).rejects.toThrow(/AUTOMATION_CREATE_LIMIT_REACHED/);
});

it("answers permanent bindings, fails closed on a damaged store", async () => {
  const s = service(dir);
  await s.handle(
    "automation/create",
    {
      cronExpr: "0 9 * * *",
      prompt: "first",
      targetTaskId: "native-1",
    },
    context,
  );
  expect(
    record(
      await s.handle(
        "automation/checkTaskBinding",
        { targetTaskId: "native-1" },
        context,
      ),
    ).bound,
  ).toBe(true);
  expect(
    record(
      await s.handle(
        "automation/checkTaskBinding",
        { targetTaskId: "native-2" },
        context,
      ),
    ).bound,
  ).toBe(false);
  // An empty store legitimately answers unbound...
  const empty = service(mkdtempSync(join(tmpdir(), "bb-zcode-automations-")));
  expect(
    record(
      await empty.handle(
        "automation/checkTaskBinding",
        { targetTaskId: "native-1" },
        context,
      ),
    ).bound,
  ).toBe(false);
  // ...but a store that cannot be parsed must fail closed on every port:
  // answering "unbound" from a replacement would re-open recursive creation.
  const damaged = mkdtempSync(join(tmpdir(), "bb-zcode-automations-"));
  writeFileSync(join(damaged, "automations.json"), "{ not json");
  const broken = service(damaged);
  await expect(
    broken.handle(
      "automation/checkTaskBinding",
      { targetTaskId: "native-1" },
      context,
    ),
  ).rejects.toThrow();
  await expect(
    broken.handle(
      "automation/create",
      { cronExpr: "* * * * *", prompt: "x" },
      context,
    ),
  ).rejects.toThrow();
});

it("updates semantics without resurrecting finished one-shots cosmetically", async () => {
  const fixed = new Date("2026-10-23T10:00:00Z");
  const s = service(dir, () => fixed);
  const created = record(
    await s.handle(
      "automation/create",
      {
        cronExpr: "*/5 * * * *",
        prompt: "tick",
        recurring: false,
      },
      context,
    ),
  ) as { automation: { automationId: string; nextRunAt: number } };
  await s.completeRun(created.automation.automationId, true);
  const afterRun = record(await s.handle("automation/list", {}, context)) as {
    automations: Array<Record<string, unknown>>;
  };
  expect(afterRun.automations[0].lifecycleStatus).toBe("completed");
  const retitled = record(
    await s.handle(
      "automation/update",
      {
        automationId: created.automation.automationId,
        title: "new title",
      },
      context,
    ),
  ) as { automation: Record<string, unknown> };
  expect(retitled.automation.title).toBe("new title");
  expect(retitled.automation.lifecycleStatus).toBe("completed");
  const revived = record(
    await s.handle(
      "automation/update",
      {
        automationId: created.automation.automationId,
        cronExpr: "*/10 * * * *",
      },
      context,
    ),
  ) as { automation: Record<string, unknown> };
  expect(revived.automation.lifecycleStatus).toBe("active");
  expect(revived.automation.cronExpr).toBe("*/10 * * * *");
});

it("completes recurring runs and stops them after three failures", async () => {
  const fixed = new Date("2026-10-23T10:00:00Z");
  const s = service(dir, () => fixed);
  const created = record(
    await s.handle(
      "automation/create",
      {
        cronExpr: "*/5 * * * *",
        prompt: "tick",
      },
      context,
    ),
  ) as { automation: { automationId: string } };
  const id = created.automation.automationId;
  await s.completeRun(id, true);
  let list = record(await s.handle("automation/list", {}, context)) as {
    automations: Array<Record<string, unknown>>;
  };
  expect(list.automations[0].runCount).toBe(1);
  expect(list.automations[0].lifecycleStatus).toBe("active");
  expect(list.automations[0].nextRunAt).toBeGreaterThan(fixed.getTime());
  await s.completeRun(id, false, "boom");
  await s.completeRun(id, false, "boom");
  await s.completeRun(id, false, "boom");
  list = record(await s.handle("automation/list", {}, context)) as {
    automations: Array<Record<string, unknown>>;
  };
  expect(list.automations[0].lifecycleStatus).toBe("failed");
  expect((await s.find(id))?.lastError).toBe("boom");
  expect(s.due(new Date(Date.now() + 86_400_000))).toHaveLength(0);
});

it("defers busy dispatches and gives up after ten minutes", async () => {
  const fixed = new Date("2026-10-23T10:00:00Z");
  const s = service(dir, () => fixed);
  const created = record(
    await s.handle(
      "automation/create",
      {
        cronExpr: "* * * * *",
        prompt: "tick",
      },
      context,
    ),
  ) as { automation: { automationId: string } };
  const id = created.automation.automationId;
  const first = new Date("2026-10-23T10:00:30Z");
  expect(s.due(first)).toHaveLength(0);
  const dueAt = new Date("2026-10-23T10:01:00Z");
  expect(s.due(dueAt)).toHaveLength(1);
  expect(s.beginRun(id, dueAt)).toBe(true);
  expect(s.beginRun(id, dueAt)).toBe(false);
  s.deferRun(id, dueAt);
  expect(s.beginRun(id, new Date("2026-10-23T10:01:30Z"))).toBe(false);
  expect(s.beginRun(id, new Date("2026-10-23T10:02:00Z"))).toBe(true);
  expect(s.runOverdue(id, new Date("2026-10-23T10:11:30Z"))).toBe(true);
  s.completeRun(id, true);
  expect(s.runOverdue(id, new Date("2026-10-23T10:12:00Z"))).toBe(false);
});

// ---- Dispatch-level: the bridge runs a due automation through a synthetic peer.

function dispatchHarness(storeDir: string, holdTurns = false) {
  const cwd = mkdtempSync(join(tmpdir(), "bb-zcode-automation-bridge-"));
  const messages: Record<string, unknown>[] = [];
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const native = new Map<string, { cb?: ClientCallbacks; closed?: boolean }>();
  let serial = 0,
    rid = 0;
  const bridge = createBridge({
    write: (m) => messages.push(m),
    automationTickMs: 20,
    accountFactory: () => ({
      async initialize() {},
      async authorize() {
        return { headersApplied: false };
      },
      close() {},
    }),
    clientFactory: (_launch, _cwd, cb) => {
      let nativeId = "";
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
        projection: { turnCount: 0, backgroundJobs: [] },
      });
      return {
        async request(method, raw) {
          const p = record(raw);
          calls.push({ method, params: p });
          if (method === "session/create") {
            nativeId = `native-${++serial}`;
            native.set(nativeId, { cb });
            return snapshot();
          }
          if (method === "session/resume") {
            nativeId = String(p.sessionId);
            const existing = native.get(nativeId);
            if (!existing) throw new Error("Unknown session");
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
            s.cb?.notification({
              method: "session/event",
              params: {
                sessionId: nativeId,
                type: "turn.started",
                eventSeq: 1,
                turnId: "turn-1",
                payload: {},
              },
            });
            if (!holdTurns)
              setTimeout(
                () =>
                  s.cb?.notification({
                    method: "session/event",
                    params: {
                      sessionId: nativeId,
                      type: "turn.completed",
                      eventSeq: 2,
                      turnId: "turn-1",
                      payload: {
                        resultType: "success",
                        response: "report done",
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
    throw new Error("Automation dispatch probe timed out");
  }
  async function rpc(method: string, params: unknown) {
    const id = ++rid;
    bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    await until(() => messages.some((m) => m.id === id && !m.method));
    return messages.find((m) => m.id === id && !m.method)!;
  }
  return { bridge, messages, calls, native, cwd, until, rpc };
}

const dispatchOptions = {
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
  providerOptions: { executable: process.execPath, automationsEnabled: true },
};

it("dispatches a due automation into its bound thread and releases the headless child", async () => {
  mkdirSync(dir, { recursive: true });
  process.env.BB_BRIDGE_DIR = dir;
  const harness = dispatchHarness(dir);
  const { bridge, calls, messages, native, cwd, until, rpc } = harness;
  // Seed the store before the bridge loads it; the fake peer deterministically
  // assigns native-1 to the first session, so the binding is known upfront.
  writeFileSync(
    join(dir, "automations.json"),
    JSON.stringify({
      version: 1,
      automations: [
        {
          automationId: "automation-1",
          title: "Report",
          cronExpr: "* * * * *",
          prompt: "Run the report",
          targetTaskId: "native-1",
          threadId: "thread",
          workspacePath: cwd,
          providerOptions: dispatchOptions.providerOptions,
          enabled: true,
          lifecycleStatus: "active",
          // Due shortly after setup so the release has settled first; the
          // deterministic fake assigns native-1 to the first session.
          nextRunAt: Date.now() + 1_500,
          runCount: 0,
          recurring: true,
          createdAt: Date.now(),
        },
      ],
    }),
  );
  await rpc("thread/start", {
    threadId: "thread",
    cwd,
    options: dispatchOptions,
    instructionMode: "replace",
  });
  expect(native.has("native-1")).toBe(true);
  await rpc("thread/stop", {
    threadId: "thread",
    providerThreadId: "native-1",
    intent: "release",
    activeTurnId: null,
  });
  // The next tick cold-resumes the bound session and sends the prompt with
  // the automation marker.
  await until(() =>
    calls.some(
      (c) =>
        c.method === "session/send" && c.params.automationId === "automation-1",
    ),
  );
  const resume = calls.find((c) => c.method === "session/resume");
  expect(resume?.params.sessionId).toBe("native-1");
  const send = calls.find(
    (c) =>
      c.method === "session/send" && c.params.automationId === "automation-1",
  )!;
  expect(send.params.content).toContain("Run the report");
  // The scheduled turn streams into the bound bb thread.
  await until(() =>
    messages.some(
      (m) =>
        m.method === "thread/delta" && record(m.params).threadId === "thread",
    ),
  );
  // After the turn settles the store records the run and the headless child
  // is released.
  await until(() => native.get("native-1")!.closed === true);
  const readStore = () =>
    JSON.parse(readFileSync(join(dir, "automations.json"), "utf8")) as {
      automations: Array<Record<string, unknown>>;
    };
  await until(() => readStore().automations[0].runCount === 1);
  const stored = readStore();
  expect(stored.automations[0].lifecycleStatus).toBe("active");
  expect(stored.automations[0].lastRunAt).toBeGreaterThan(0);
  await bridge.close();
});

it("answers automation reverse RPCs only when the setting is enabled", async () => {
  const storeDir = mkdtempSync(join(tmpdir(), "bb-zcode-automation-gate-"));
  const harness = dispatchHarness(storeDir);
  const { bridge, calls, messages, rpc, cwd, until } = harness;
  await rpc("thread/start", {
    threadId: "thread",
    cwd,
    options: {
      ...dispatchOptions,
      providerOptions: { executable: process.execPath },
    },
    instructionMode: "replace",
  });
  const nativeId = String(
    record(calls.find((c) => c.method === "session/create")?.params)
      .sessionId ?? "",
  );
  // Without the setting the management command reports the ports as disabled,
  // and the reverse RPC answers with the same actionable error.
  const response = await rpc("turn/start", {
    threadId: "thread",
    providerThreadId: nativeId || "native-1",
    input: [{ type: "text", text: "/zcode-automations", mentions: [] }],
    options: dispatchOptions,
    clientRequestId: "creq_gatecmd992",
  });
  expect(JSON.stringify(response) + JSON.stringify(messages)).toContain(
    "automations are disabled",
  );
  await bridge.close();
  void until;
});

// ---- Review fixes (2026-10-23): scoping, storm guard, reservations, busy deferral.

const workspaceA = { ...context, cwd: "/workspace-a" };
const workspaceB = { ...context, cwd: "/workspace-b" };

it("scopes schedules to the creating workspace like the native index", async () => {
  const s = service(dir);
  const a = record(
    await s.handle(
      "automation/create",
      { cronExpr: "0 9 * * *", prompt: "project A", targetTaskId: "native-a" },
      workspaceA,
    ),
  ) as { automation: { automationId: string } };
  await s.handle(
    "automation/create",
    { cronExpr: "0 9 * * *", prompt: "project B", targetTaskId: "native-b" },
    workspaceB,
  );
  const listA = record(await s.handle("automation/list", {}, workspaceA)) as {
    automations: Array<Record<string, unknown>>;
  };
  expect(listA.automations).toHaveLength(1);
  expect(listA.automations[0].prompt).toBe("project A");
  // Cross-workspace ids read as unknown: no leaking, no mutation.
  await expect(
    s.handle(
      "automation/update",
      { automationId: a.automation.automationId, title: "hijack" },
      workspaceB,
    ),
  ).rejects.toThrow(/Unknown scheduled task/);
  // Delete answers boolean false cross-workspace: no leak either way.
  expect(
    record(
      await s.handle(
        "automation/delete",
        { automationId: a.automation.automationId },
        workspaceB,
      ),
    ).deleted,
  ).toBe(false);
  expect(
    record(
      await s.handle(
        "automation/checkTaskBinding",
        { targetTaskId: "native-a" },
        workspaceB,
      ),
    ).bound,
  ).toBe(false);
  expect(
    record(
      await s.handle(
        "automation/checkTaskBinding",
        { targetTaskId: "native-a" },
        workspaceA,
      ),
    ).bound,
  ).toBe(true);
  expect(s.describe("/workspace-a")).toContain("project A");
  expect(s.describe("/workspace-a")).not.toContain("project B");
  // The scoped delete still works from the owning workspace.
  expect(await s.removeById(a.automation.automationId, "/workspace-a")).toBe(
    true,
  );
});

it("fails a schedule whose next occurrence cannot be computed (storm guard)", async () => {
  const s = service(dir);
  const created = record(
    await s.handle(
      "automation/create",
      { cronExpr: "* * * * *", prompt: "tick" },
      context,
    ),
  ) as { automation: { automationId: string } };
  // Simulate a damaged/legacy entry whose cron no longer parses.
  const storePath = join(dir, "automations.json");
  const raw = JSON.parse(readFileSync(storePath, "utf8"));
  raw.automations[0].cronExpr = "not a cron";
  writeFileSync(storePath, JSON.stringify(raw));
  const reopened = service(dir);
  await reopened.ready();
  const id = created.automation.automationId;
  await reopened.completeRun(id, true);
  const entry = await reopened.find(id);
  expect(entry?.lifecycleStatus).toBe("failed");
  expect(entry?.nextRunAt).toBeUndefined();
  expect(entry?.lastError).toContain("Invalid schedule");
  expect(reopened.due(new Date(Date.now() + 86_400_000))).toHaveLength(0);
});

it("retryRun releases a reservation so the next tick can dispatch again", async () => {
  const s = service(dir);
  const created = record(
    await s.handle(
      "automation/create",
      { cronExpr: "* * * * *", prompt: "tick" },
      context,
    ),
  ) as { automation: { automationId: string } };
  const id = created.automation.automationId;
  const at = new Date("2026-10-23T10:01:00Z");
  expect(s.beginRun(id, at)).toBe(true);
  s.retryRun(id);
  expect(s.beginRun(id, at)).toBe(true);
});

it("a busy bound thread defers the run instead of recording a failure", async () => {
  mkdirSync(dir, { recursive: true });
  process.env.BB_BRIDGE_DIR = dir;
  const harness = dispatchHarness(dir, true);
  const { bridge, calls, native, cwd, until, rpc } = harness;
  writeFileSync(
    join(dir, "automations.json"),
    JSON.stringify({
      version: 1,
      automations: [
        {
          automationId: "automation-busy",
          title: "Report",
          cronExpr: "* * * * *",
          prompt: "Run the report",
          targetTaskId: "native-1",
          threadId: "thread",
          workspacePath: cwd,
          providerOptions: dispatchOptions.providerOptions,
          enabled: true,
          lifecycleStatus: "active",
          nextRunAt: Date.now() + 1_000,
          runCount: 0,
          recurring: true,
          createdAt: Date.now(),
        },
      ],
    }),
  );
  // Open a user turn that never completes; the schedule fires while it runs.
  await rpc("thread/start", {
    threadId: "thread",
    cwd,
    options: dispatchOptions,
    instructionMode: "replace",
    input: [{ type: "text", text: "hold this turn", mentions: [] }],
  });
  expect(native.has("native-1")).toBe(true);
  // Give the scheduler several ticks past the due time: a busy session must
  // defer, not burn failure strikes or start a second turn.
  await new Promise((r) => setTimeout(r, 1_600));
  const stored = JSON.parse(
    readFileSync(join(dir, "automations.json"), "utf8"),
  );
  expect(stored.automations[0].runCount).toBe(0);
  expect(stored.automations[0].lifecycleStatus).toBe("active");
  expect(stored.automations[0].lastError).toBeUndefined();
  expect(
    calls.some(
      (c) =>
        c.method === "session/send" &&
        c.params.automationId === "automation-busy",
    ),
  ).toBe(false);
  await bridge.close();
  void until;
});

it("dispatches a management-command prompt natively instead of intercepting it", async () => {
  mkdirSync(dir, { recursive: true });
  process.env.BB_BRIDGE_DIR = dir;
  const harness = dispatchHarness(dir);
  const { bridge, calls, native, cwd, until, rpc } = harness;
  writeFileSync(
    join(dir, "automations.json"),
    JSON.stringify({
      version: 1,
      automations: [
        {
          automationId: "automation-cmd",
          title: "Command",
          cronExpr: "* * * * *",
          prompt: "/zcode-tasks",
          targetTaskId: "native-1",
          threadId: "thread",
          workspacePath: cwd,
          providerOptions: dispatchOptions.providerOptions,
          enabled: true,
          lifecycleStatus: "active",
          nextRunAt: Date.now() + 1_500,
          runCount: 0,
          recurring: true,
          createdAt: Date.now(),
        },
      ],
    }),
  );
  await rpc("thread/start", {
    threadId: "thread",
    cwd,
    options: dispatchOptions,
    instructionMode: "replace",
  });
  await rpc("thread/stop", {
    threadId: "thread",
    providerThreadId: "native-1",
    intent: "release",
    activeTurnId: null,
  });
  // The scheduled prompt must reach the native side as task data; the local
  // command branch would finish without settle(), stranding the run marker.
  await until(() =>
    calls.some(
      (c) =>
        c.method === "session/send" &&
        c.params.automationId === "automation-cmd",
    ),
  );
  const send = calls.find(
    (c) =>
      c.method === "session/send" && c.params.automationId === "automation-cmd",
  )!;
  expect(send.params.content).toContain("/zcode-tasks");
  const readStore = () =>
    JSON.parse(readFileSync(join(dir, "automations.json"), "utf8")) as {
      automations: Array<Record<string, unknown>>;
    };
  await until(() => readStore().automations[0].runCount === 1);
  await until(() => native.get("native-1")!.closed === true);
  await bridge.close();
});
