import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createBridge } from "../src/bridge.js";
import { record } from "../src/protocol.js";
import { ProtocolError, type ClientCallbacks } from "../src/client.js";
import { threadDeltaNotificationParamsSchema } from "@get-bb/plugin-sdk/provider-bridge";

const options = {
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
  providerOptions: { executable: process.execPath },
  model: "test/model",
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((f) => f()));
});
function harness(compatible = true) {
  const cwd = mkdtempSync(join(tmpdir(), "bb-zcode-lifecycle-"));
  const messages: Record<string, unknown>[] = [],
    calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const sessions = new Map<
    string,
    {
      rows: Record<string, unknown>[];
      jobs: Record<string, unknown>[];
      cb?: ClientCallbacks;
      seq: number;
      turn: number;
      epoch?: string;
    }
  >();
  let serial = 0,
    rid = 0;
  const bridge = createBridge({
    write: (m) => messages.push(m),
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
        projection: {
          turnCount: sessions.get(nativeId)!.turn,
          backgroundJobs: sessions.get(nativeId)!.jobs,
        },
      });
      return {
        async request(method, raw) {
          const p = record(raw);
          calls.push({ method, params: p });
          if (method === "session/create") {
            nativeId = `native-${++serial}`;
            sessions.set(nativeId, { rows: [], jobs: [], seq: 0, turn: 0, cb });
            return snapshot();
          }
          if (method === "session/resume") {
            nativeId = String(p.sessionId);
            if (!sessions.has(nativeId)) throw new Error("Unknown session");
            sessions.get(nativeId)!.cb = cb;
            return snapshot();
          }
          if (method === "session/read") return snapshot();
          if (method === "plugins/list")
            return {
              plugins: [
                {
                  id: "official-tools",
                  name: "Official Tools",
                  description: "Bundled fixture tools",
                  version: "1.2.0",
                  enabled: true,
                  marketplace: "zcode",
                  source: "builtin",
                  mcpServerNames: [],
                  skillRootCount: 0,
                  commandRootCount: 0,
                  rootPath: "/fixture",
                },
                {
                  id: "extra",
                  name: "Extra",
                  enabled: false,
                  marketplace: "community",
                  source: "git",
                  mcpServerNames: [],
                  skillRootCount: 0,
                  commandRootCount: 0,
                  rootPath: "/fixture",
                },
              ],
              diagnostics: [],
            };
          if (method === "plugins/install")
            return {
              installedPlugins: [
                {
                  id: "demo",
                  name: "Demo Plugin",
                  marketplace: String(p.marketplace),
                  enabled: true,
                  scope: "user",
                },
              ],
              dependencyClosure: ["demo"],
              diagnostics: [],
            };
          if (method === "v4/conversation/rowsRange") {
            if (!compatible) throw new ProtocolError("Unknown method", -32601);
            return {
              rows: sessions.get(String(p.sessionId))!.rows,
              atSeq: 1,
              atRevision: 7,
              atLogEpoch: sessions.get(String(p.sessionId))!.epoch ?? "epoch",
              hasMore: false,
            };
          }
          if (method === "v4/command") {
            const source = sessions.get(String(p.sessionId))!;
            if (p.type === "forkAssistant") {
              const row = record(record(p.payload).target);
              const child = `native-${++serial}`;
              sessions.set(child, {
                rows: source.rows.filter(
                  (r) => Number(r.rowId) <= Number(row.rowId),
                ),
                jobs: [],
                seq: 0,
                turn: source.turn,
              });
              return {
                commandId: p.commandId,
                status: "accepted",
                revisionAtDecision: 7,
                result: { type: "forkAssistant", sessionId: child },
              };
            }
            if (p.type === "cancelBackgroundWork") {
              const job = source.jobs.find(
                (j) => j.taskId === record(p.payload).workId,
              );
              if (!job)
                return {
                  commandId: p.commandId,
                  status: "failed",
                  revisionAtDecision: 7,
                  reasonCode:
                    "fault.command.backgroundWorkCancelRejected.not_found",
                };
              job.status = "cancelled";
              return {
                commandId: p.commandId,
                status: "accepted",
                revisionAtDecision: 7,
              };
            }
            return {
              commandId: p.commandId,
              status: "accepted",
              revisionAtDecision: 7,
              result: {
                type: "applyFileRewind",
                applied: true,
                preview: { canApply: true },
                response: "Restored fixture files",
              },
            };
          }
          if (method === "v4/conversation/backgroundBashOutput")
            return {
              kind: "output",
              workId: p.workId,
              status: "running",
              output: "fixture output",
              truncated: false,
              outputPath: "/fixture/output",
            };
          if (method === "v4/conversation/fileRewindPreview")
            return {
              canApply: true,
              safeFiles: [{ path: "fixture.txt" }],
              unsafeFiles: [],
              ignoredFiles: [],
            };
          if (method === "session/send") {
            const s = sessions.get(nativeId)!;
            s.turn++;
            cb.notification({
              method: "session/event",
              params: {
                sessionId: nativeId,
                type: "turn.started",
                eventSeq: ++s.seq,
                turnId: `turn-${s.turn}`,
                payload: {},
              },
            });
            return { accepted: true };
          }
          return {};
        },
        async close() {},
      };
    },
  });
  cleanups.push(bridge.close);
  async function until(check: () => boolean) {
    for (let i = 0; i < 500; i++) {
      if (check()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("Lifecycle probe timed out");
  }
  async function rpc(method: string, params: unknown) {
    const id = ++rid;
    bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    await until(() => messages.some((m) => m.id === id && !m.method));
    return messages.find((m) => m.id === id && !m.method)!;
  }
  const deltas = (threadId = "thread") =>
    messages
      .filter(
        (m) =>
          m.method === "thread/delta" && record(m.params).threadId === threadId,
      )
      .flatMap((m) => record(m.params).deltas as Record<string, unknown>[]);
  async function start() {
    const r = await rpc("thread/start", {
      threadId: "thread",
      cwd,
      options,
      instructionMode: "append",
    });
    expect(r.error).toBeUndefined();
    return String(record(r.result).providerThreadId);
  }
  async function send(nativeId: string, text: string) {
    return rpc("turn/start", {
      threadId: "thread",
      providerThreadId: nativeId,
      options,
      input: [{ type: "text", text, mentions: [] }],
      clientRequestId: `creq_abcdefgh${"23456789abcdefghijkmnpqrstuvwxyz"[rid % 31]}2`,
    });
  }
  async function complete(nativeId: string) {
    const s = sessions.get(nativeId)!;
    s.rows.push({
      kind: "assistantText",
      rowId: s.turn * 4,
      entityId: `message-${s.turn}`,
      turnId: `turn-${s.turn}`,
      state: "complete",
      actions: { canFork: true },
      text: `answer-${s.turn}`,
    });
    const before = deltas().filter((d) => d.kind === "turn.boundary").length;
    s.cb!.notification({
      method: "session/event",
      params: {
        sessionId: nativeId,
        type: "turn.completed",
        eventSeq: ++s.seq,
        turnId: `turn-${s.turn}`,
        payload: { resultType: "success", response: `answer-${s.turn}` },
      },
    });
    await until(
      () => deltas().filter((d) => d.kind === "turn.boundary").length > before,
    );
  }
  return {
    bridge,
    cwd,
    messages,
    calls,
    sessions,
    rpc,
    deltas,
    start,
    send,
    complete,
    until,
    refresh(nativeId: string) {
      sessions.get(nativeId)!.cb!.notification({
        method: "state.updated",
        params: { sessionId: nativeId, reason: "background_task_updated" },
      });
    },
  };
}

it("publishes stable native checkpoints and uses them for bb forks/rewind", async () => {
  const h = harness(),
    id = await h.start();
  await h.send(id, "first");
  await h.complete(id);
  const checkpoint = h
    .deltas()
    .find((d) => d.kind === "turn.boundary")?.providerCheckpointId;
  expect(typeof checkpoint).toBe("string");
  await h.send(id, "second");
  await h.complete(id);
  const result = await h.rpc("thread/fork", {
    threadId: "child",
    sourceProviderThreadId: id,
    sourceProviderCheckpointId: checkpoint,
    cwd: h.cwd,
    options,
    instructionMode: "append",
  });
  expect(result.error).toBeUndefined();
  const child = String(record(result.result).providerThreadId);
  expect(child).not.toBe(id);
  expect(h.sessions.get(child)!.rows.map((r) => r.entityId)).toEqual([
    "message-1",
  ]);
  expect(h.sessions.get(id)!.rows).toHaveLength(2);
  expect(h.calls.find((c) => c.method === "v4/command")?.params).toMatchObject({
    type: "forkAssistant",
    sessionId: id,
    baseRevision: 7,
    baseLogEpoch: "epoch",
    payload: { target: { rowId: 4, entityId: "message-1" } },
  });
});

it("forks at the native tip when no checkpoint is requested", async () => {
  const h = harness(),
    id = await h.start();
  await h.send(id, "hello");
  await h.complete(id);
  const r = await h.rpc("thread/fork", {
    threadId: "child",
    sourceProviderThreadId: id,
    cwd: h.cwd,
    options,
    instructionMode: "append",
  });
  expect(r.error).toBeUndefined();
  expect(
    h.sessions.get(String(record(r.result).providerThreadId))!.rows,
  ).toHaveLength(1);
});

it("retains background work through foreground settlement and closes it afterwards", async () => {
  const h = harness(),
    id = await h.start();
  await h.send(id, "background");
  const job = {
    taskId: "work-1",
    taskKind: "bash",
    command: "echo fixture",
    status: "running",
    cancellable: true,
  };
  h.sessions.get(id)!.jobs = [job];
  await h.complete(id);
  expect(
    h
      .deltas()
      .some(
        (d) =>
          d.kind === "item.open" && record(d.item).type === "backgroundTask",
      ),
  ).toBe(true);
  expect(
    h
      .deltas()
      .filter(
        (d) =>
          d.kind === "item.close" && record(d.item).type === "backgroundTask",
      ),
  ).toHaveLength(0);
  job.status = "completed";
  h.refresh(id);
  await h.until(() =>
    h
      .deltas()
      .some(
        (d) =>
          d.kind === "item.close" && record(d.item).taskStatus === "completed",
      ),
  );
  expect(h.deltas().findIndex((d) => d.kind === "turn.boundary")).toBeLessThan(
    h
      .deltas()
      .findIndex(
        (d) =>
          d.kind === "item.close" && record(d.item).type === "backgroundTask",
      ),
  );
  for (const m of h.messages.filter((m) => m.method === "thread/delta"))
    expect(
      threadDeltaNotificationParamsSchema.safeParse(m.params).success,
    ).toBe(true);
});

it("provides task list/output/stop commands without calling the model", async () => {
  const h = harness(),
    id = await h.start();
  h.sessions.get(id)!.jobs = [
    {
      taskId: "work-1",
      taskKind: "bash",
      status: "running",
      cancellable: true,
    },
  ];
  h.refresh(id);
  await h.send(id, "/zcode-tasks");
  await h.send(id, "/zcode-task-output work-1");
  await h.send(id, "/zcode-task-stop work-1");
  expect(h.calls.filter((c) => c.method === "session/send")).toHaveLength(0);
  expect(
    h.calls.some((c) => c.method === "v4/conversation/backgroundBashOutput"),
  ).toBe(true);
  expect(
    h.calls.some(
      (c) =>
        c.method === "v4/command" && c.params.type === "cancelBackgroundWork",
    ),
  ).toBe(true);
  expect(
    h.deltas().some((d) => String(d.text).includes("fixture output")),
  ).toBe(true);
});

it("rejects unknown task identifiers without dispatching cancellation", async () => {
  const h = harness(),
    id = await h.start();
  const r = await h.send(id, "/zcode-task-stop other-work");
  expect(r.error).toBeDefined();
  expect(h.calls.some((c) => c.method === "v4/command")).toBe(false);
});

it("rejects idle release while native background work remains open", async () => {
  const h = harness(),
    id = await h.start();
  h.sessions.get(id)!.jobs = [
    {
      taskId: "work-1",
      taskKind: "bash",
      status: "running",
      cancellable: true,
    },
  ];
  h.refresh(id);
  await h.until(() =>
    h.deltas().some((d) => record(d.item).type === "backgroundTask"),
  );
  expect(
    (
      await h.rpc("thread/stop", {
        threadId: "thread",
        providerThreadId: id,
        intent: "release",
        activeTurnId: null,
      })
    ).error,
  ).toBeDefined();
});

it("fails explicitly for management on a native CLI without v4 control queries", async () => {
  const h = harness(false),
    id = await h.start();
  const r = await h.send(id, "/zcode-tasks");
  expect(r.error).toBeDefined();
  expect(h.calls.some((c) => c.method === "session/send")).toBe(false);
});

it("rejects foreign and missing checkpoints without mutating history", async () => {
  const h = harness(),
    id = await h.start();
  await h.send(id, "hello");
  await h.complete(id);
  const checkpoint = String(
    h.deltas().find((d) => d.kind === "turn.boundary")!.providerCheckpointId,
  );
  const token = JSON.parse(
    Buffer.from(checkpoint.slice(9), "base64url").toString(),
  );
  for (const change of [
    { sessionId: "foreign" },
    { rowId: 999, entityId: "missing" },
  ]) {
    const invalid =
      "zcode-v1-" +
      Buffer.from(JSON.stringify({ ...token, ...change })).toString(
        "base64url",
      );
    const r = await h.rpc("thread/fork", {
      threadId: "child",
      sourceProviderThreadId: id,
      sourceProviderCheckpointId: invalid,
      cwd: h.cwd,
      options,
      instructionMode: "append",
    });
    expect(r.error).toBeDefined();
  }
  expect(h.calls.some((c) => c.method === "v4/command")).toBe(false);
});
it("settles background work on native child death", async () => {
  const h = harness(),
    id = await h.start();
  h.sessions.get(id)!.jobs = [
    {
      taskId: "agent-1",
      taskKind: "subagent",
      status: "running",
      cancellable: true,
    },
  ];
  h.refresh(id);
  await h.until(() =>
    h.deltas().some((d) => record(d.item).type === "delegation"),
  );
  h.sessions.get(id)!.cb!.exit(new Error("fixture crash"));
  expect(
    h
      .deltas()
      .some(
        (d) =>
          d.kind === "item.close" &&
          d.status === "failed" &&
          record(d.item).type === "delegation",
      ),
  ).toBe(true);
});
it("requires a preview token before applying native file rewind", async () => {
  const h = harness(),
    id = await h.start();
  await h.send(id, "hello");
  await h.complete(id);
  h.sessions.get(id)!.rows.unshift({
    kind: "turnHeader",
    rowId: 1,
    entityId: "header-1",
    turnId: "turn-1",
    actions: { canRewindFiles: true },
  });
  expect((await h.send(id, "/zcode-file-rewind unknown")).error).toBeDefined();
  expect(h.calls.some((c) => c.method === "v4/command")).toBe(false);
  const preview = await h.send(id, "/zcode-file-preview");
  expect(preview.error).toBeUndefined();
  const output = h
    .deltas()
    .filter((d) => d.kind === "item.textClose")
    .map((d) => String(d.text))
    .join("\n");
  const token = output.match(/\/zcode-file-rewind (preview-[a-f0-9-]+)/)?.[1];
  expect(token).toBeTruthy();
  expect(
    (await h.send(id, `/zcode-file-rewind ${token}`)).error,
  ).toBeUndefined();
  expect(h.calls.find((c) => c.method === "v4/command")?.params).toMatchObject({
    type: "applyFileRewind",
    baseRevision: 7,
    baseLogEpoch: "epoch",
    payload: { target: { rowId: 1, entityId: "header-1" } },
  });
  expect(h.calls.filter((c) => c.method === "session/send")).toHaveLength(1);
});

it("rebinds a persisted checkpoint by stable entity identity after native restart", async () => {
  const h = harness(),
    id = await h.start();
  await h.send(id, "hello");
  await h.complete(id);
  const checkpoint = h
    .deltas()
    .find((d) => d.kind === "turn.boundary")!.providerCheckpointId;
  const source = h.sessions.get(id)!;
  source.epoch = "restarted";
  source.rows[0]!.rowId = 18;
  const result = await h.rpc("thread/fork", {
    threadId: "cold-child",
    sourceProviderThreadId: id,
    sourceProviderCheckpointId: checkpoint,
    cwd: h.cwd,
    options,
    instructionMode: "append",
  });
  expect(result.error).toBeUndefined();
  expect(h.calls.find((c) => c.method === "v4/command")?.params).toMatchObject({
    baseLogEpoch: "restarted",
    payload: { target: { rowId: 18, entityId: "message-1" } },
  });
});

it("does not release background work that has not emitted a notification yet", async () => {
  const h = harness(),
    id = await h.start();
  h.sessions.get(id)!.jobs = [
    {
      taskId: "late-work",
      taskKind: "bash",
      status: "running",
      cancellable: true,
    },
  ];
  expect(
    (
      await h.rpc("thread/stop", {
        threadId: "thread",
        providerThreadId: id,
        intent: "release",
        activeTurnId: null,
      })
    ).error,
  ).toBeDefined();
});
it("allows a conversation fork into a different authorized workspace", async () => {
  const h = harness(),
    id = await h.start();
  await h.send(id, "hello");
  await h.complete(id);
  const r = await h.rpc("thread/fork", {
    threadId: "different-workspace",
    sourceProviderThreadId: id,
    cwd: mkdtempSync(join(tmpdir(), "bb-zcode-fork-")),
    options,
    instructionMode: "append",
  });
  expect(r.error).toBeUndefined();
});
it("does not silently fork an older tip while the latest turn is active", async () => {
  const h = harness(),
    id = await h.start();
  await h.send(id, "one");
  await h.complete(id);
  await h.send(id, "still running");
  expect(
    (
      await h.rpc("thread/fork", {
        threadId: "child",
        sourceProviderThreadId: id,
        cwd: h.cwd,
        options,
        instructionMode: "append",
      })
    ).error,
  ).toBeDefined();
  expect(h.calls.some((c) => c.method === "v4/command")).toBe(false);
});
it("cancels background work when bb interrupts an idle session", async () => {
  const h = harness(),
    id = await h.start();
  h.sessions.get(id)!.jobs = [
    {
      taskId: "work-1",
      taskKind: "bash",
      status: "running",
      cancellable: true,
    },
  ];
  expect(
    (
      await h.rpc("thread/stop", {
        threadId: "thread",
        providerThreadId: id,
        intent: "interrupt",
        activeTurnId: null,
      })
    ).error,
  ).toBeUndefined();
  expect(
    h.calls.some(
      (c) =>
        c.method === "v4/command" &&
        record(c.params.payload).workId === "work-1",
    ),
  ).toBe(true);
});

it("rebinds an idle bb thread to its prepared rewind fork", async () => {
  const h = harness(),
    id = await h.start();
  await h.send(id, "first");
  await h.complete(id);
  const checkpoint = h
    .deltas()
    .find((d) => d.kind === "turn.boundary")!.providerCheckpointId;
  await h.send(id, "second");
  await h.complete(id);
  const fork = await h.rpc("thread/fork", {
    threadId: "thread:rewind:lease",
    sourceProviderThreadId: id,
    sourceProviderCheckpointId: checkpoint,
    cwd: h.cwd,
    options,
    instructionMode: "append",
  });
  const child = record(fork.result).providerThreadId;
  await h.rpc("thread/discard", {
    threadId: "thread:rewind:lease",
    providerThreadId: child,
  });
  const resumed = await h.rpc("thread/resume", {
    threadId: "thread",
    providerThreadId: child,
    cwd: h.cwd,
    options,
    instructionMode: "append",
  });
  expect(resumed.error).toBeUndefined();
  expect(record(resumed.result).providerThreadId).toBe(child);
  expect(h.sessions.get(id)!.rows).toHaveLength(2);
  expect(h.sessions.get(String(child))!.rows).toHaveLength(1);
});

it.each(["plan", "background"])(
  "blocks file rollback during %s activity",
  async (activity) => {
    const h = harness(),
      id = await h.start();
    await h.send(id, "hello");
    await h.complete(id);
    h.sessions.get(id)!.rows.unshift({
      kind: "turnHeader",
      rowId: 1,
      entityId: "header-1",
      turnId: "turn-1",
      actions: { canRewindFiles: true },
    });
    await h.send(id, "/zcode-file-preview");
    const output = h
      .deltas()
      .filter((d) => d.kind === "item.textClose")
      .map((d) => String(d.text))
      .join("\n");
    const token = output.match(/preview-[a-f0-9-]+/)![0];
    if (activity === "background")
      h.sessions.get(id)!.jobs = [
        {
          taskId: "unannounced",
          taskKind: "bash",
          status: "running",
          cancellable: true,
        },
      ];
    const r = await h.rpc("turn/start", {
      threadId: "thread",
      providerThreadId: id,
      options: {
        ...options,
        ...(activity === "plan" ? { promptMode: "plan" } : {}),
      },
      clientRequestId: "creq_abcdefghq2",
      input: [
        { type: "text", text: `/zcode-file-rewind ${token}`, mentions: [] },
      ],
    });
    expect(r.error).toBeDefined();
    expect(h.calls.some((c) => c.method === "v4/command")).toBe(false);
  },
);

it("commits bb rewind by forking a staged tip over the idle target", async () => {
  const h = harness(),
    id = await h.start();
  await h.send(id, "first");
  await h.complete(id);
  const checkpoint = h
    .deltas()
    .find((d) => d.kind === "turn.boundary")!.providerCheckpointId;
  await h.send(id, "second");
  await h.complete(id);
  const staged = await h.rpc("thread/fork", {
    threadId: "staging",
    sourceProviderThreadId: id,
    sourceProviderCheckpointId: checkpoint,
    cwd: h.cwd,
    options,
    instructionMode: "append",
  });
  const stageId = record(staged.result).providerThreadId;
  const committed = await h.rpc("thread/fork", {
    threadId: "thread",
    sourceProviderThreadId: stageId,
    cwd: h.cwd,
    options,
    instructionMode: "append",
  });
  expect(committed.error).toBeUndefined();
  expect(h.sessions.get(id)!.rows).toHaveLength(2);
  expect(
    h.sessions.get(String(record(committed.result).providerThreadId))!.rows,
  ).toHaveLength(1);
});

it("answers provider usage from sessionless discovery without a model prompt", async () => {
  const h = harness();
  const r = await h.rpc("provider/usage", {
    providerId: "zcode",
    cwd: h.cwd,
    providerOptions: { executable: process.execPath },
  });
  expect(record(r.result)).toMatchObject({
    supported: true,
    usage: { status: "ok", accountEmail: null, planLabel: null, windows: [] },
  });
  expect(h.calls.some((c) => c.method === "session/send")).toBe(false);
});

it("tests model connectivity explicitly through /zcode-check", async () => {
  const h = harness(),
    id = await h.start();
  const r = await h.send(id, "/zcode-check");
  expect(r.error).toBeUndefined();
  expect(
    h.calls.find((c) => c.method === "provider/testModelConnectivity"),
  ).toMatchObject({
    params: { selection: { providerId: "test", modelId: "model" } },
  });
  expect(h.calls.some((c) => c.method === "session/send")).toBe(false);
  expect(h.deltas().some((d) => String(d.text).includes("test/model"))).toBe(
    true,
  );
});

it("accepts an explicit model in /zcode-check and rejects malformed ids", async () => {
  const h = harness(),
    id = await h.start();
  const ok = await h.send(id, "/zcode-check other/model");
  expect(ok.error).toBeUndefined();
  expect(
    h.calls
      .filter((c) => c.method === "provider/testModelConnectivity")
      .some((c) => record(c.params.selection).providerId === "other"),
  ).toBe(true);
  const bad = await h.send(id, "/zcode-check noslashes");
  expect(bad.error).toBeDefined();
});

it("acks bb-local archive, unarchive and rename without native calls", async () => {
  const h = harness();
  for (const method of [
    "thread/archive",
    "thread/unarchive",
    "thread/name/set",
  ]) {
    const r = await h.rpc(method, {
      threadId: "thread",
      providerThreadId: "native-1",
      ...(method === "thread/name/set" ? { title: "Renamed" } : {}),
    });
    expect(r.error, method).toBeUndefined();
  }
  expect(h.calls).toHaveLength(0);
});

it("clears native goals through thread/goal/clear with an active session", async () => {
  const h = harness(),
    id = await h.start();
  const r = await h.rpc("thread/goal/clear", {
    threadId: "thread",
    providerThreadId: id,
  });
  expect(r.error).toBeUndefined();
  expect(h.calls.find((c) => c.method === "session/goal")).toMatchObject({
    params: { sessionId: id, action: "clear" },
  });
  expect(h.calls.some((c) => c.method === "session/send")).toBe(false);
});

it("rejects goal clearing without the thread's active session", async () => {
  const h = harness();
  const r = await h.rpc("thread/goal/clear", {
    threadId: "thread",
    providerThreadId: "native-1",
  });
  expect(r.error).toBeDefined();
  expect(h.calls.some((c) => c.method === "session/goal")).toBe(false);
});

it("lists native ZCode plugins without a model prompt", async () => {
  const h = harness(),
    id = await h.start();
  const r = await h.send(id, "/zcode-plugin list");
  expect(r.error).toBeUndefined();
  expect(
    h.deltas().some((d) => String(d.text).includes("Official Tools")),
  ).toBe(true);
  expect(h.deltas().some((d) => String(d.text).includes("[disabled]"))).toBe(
    true,
  );
  expect(h.calls.some((c) => c.method === "session/send")).toBe(false);
});

it("installs native plugins with name and marketplace", async () => {
  const h = harness(),
    id = await h.start();
  const r = await h.send(id, "/zcode-plugin install demo community");
  expect(r.error).toBeUndefined();
  expect(h.calls.find((c) => c.method === "plugins/install")).toMatchObject({
    params: { pluginName: "demo", marketplace: "community" },
  });
  expect(h.deltas().some((d) => String(d.text).includes("Demo Plugin"))).toBe(
    true,
  );
});

it("enables and disables native plugins by id", async () => {
  const h = harness(),
    id = await h.start();
  await h.send(id, "/zcode-plugin disable official-tools");
  expect(h.calls.find((c) => c.method === "plugins/setEnabled")).toMatchObject({
    params: { pluginId: "official-tools", enabled: false },
  });
  await h.send(id, "/zcode-plugin enable official-tools");
  expect(
    h.calls
      .filter((c) => c.method === "plugins/setEnabled")
      .some((c) => record(c.params).enabled === true),
  ).toBe(true);
});

it("rejects malformed plugin commands without native calls", async () => {
  const h = harness(),
    id = await h.start();
  for (const bad of [
    "/zcode-plugin install onlyname",
    "/zcode-plugin enable",
    "/zcode-plugin nonsense",
  ]) {
    const r = await h.send(id, bad);
    expect(r.error, bad).toBeDefined();
  }
  expect(h.calls.some((c) => c.method.startsWith("plugins/"))).toBe(false);
});

it("rejects native host-service ports with actionable messages", async () => {
  const h = harness(),
    id = await h.start();
  const cb = h.sessions.get(id)!.cb!;
  await expect(
    cb.request("interaction/browserExecute", { sessionId: id }),
  ).rejects.toThrow(/Browser control.*ZCode Desktop/);
  await expect(
    cb.request("automation/list", { sessionId: id }),
  ).rejects.toThrow(/ZCode automations.*ZCode Desktop/);
  await expect(
    cb.request("mcp/uiOpenInstance", { sessionId: id }),
  ).rejects.toThrow(/ZCode MCP Apps.*ZCode Desktop/);
  await expect(
    cb.request("bot/channel/reply", { sessionId: id }),
  ).rejects.toThrow(/topic resources.*ZCode Desktop/);
});
