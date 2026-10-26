import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createBridge } from "../src/bridge.js";
import { record } from "../src/protocol.js";
import type { ClientCallbacks } from "../src/client.js";

const options = {
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
  providerOptions: { executable: process.execPath },
  model: "test/model",
};
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.allSettled(closes.splice(0).map((f) => f()));
});

const UPSTREAM_ERROR = "Provider returned a server error.";

function harness(
  config: { retryDelaysMs?: number[]; retryStartTimeoutMs?: number } = {},
) {
  let callbacks: ClientCallbacks,
    seq = 0,
    turn = 0,
    id = 0;
  const messages: Record<string, unknown>[] = [],
    calls: { method: string; params: Record<string, unknown> }[] = [];
  const cwd = mkdtempSync(join(tmpdir(), "bb-zcode-retry-"));
  const snapshot = {
    session: { sessionId: "native-session" },
    settings: {
      model: {
        current: { providerId: "test", modelId: "model" },
        available: [
          {
            ref: { providerId: "test", modelId: "model" },
            label: "Model",
            contextWindow: 200000,
          },
        ],
      },
    },
    projection: { turnCount: 0, contextUsed: 1234, contextWindow: 200000 },
  };
  let historyRows: Array<Record<string, unknown>> = [
    { rowId: 1, entityId: "ent-1", kind: "userInput", state: "complete" },
  ];
  function event(
    type: string,
    payload: unknown = {},
    nativeTurnId = `native-turn-${turn}`,
    envelope: Record<string, unknown> = {},
  ) {
    callbacks.notification({
      method: "session/event",
      params: {
        sessionId: "native-session",
        type,
        payload,
        eventSeq: ++seq,
        turnId: nativeTurnId,
        ...envelope,
      },
    });
  }
  const bridge = createBridge({
    write: (m) => messages.push(m),
    retryDelaysMs: config.retryDelaysMs ?? [30, 30],
    retryStartTimeoutMs: config.retryStartTimeoutMs ?? 5_000,
    accountFactory: () => ({
      async initialize() {},
      async authorize() {
        return { headersApplied: false };
      },
      close() {},
    }),
    clientFactory: (_launch, _cwd, cb) => {
      callbacks = cb;
      return {
        async request(method, raw) {
          const params = record(raw);
          calls.push({ method, params });
          if (
            method === "session/create" ||
            method === "session/resume" ||
            method === "session/read"
          )
            return snapshot;
          if (method === "session/usage")
            return { inputTokens: 10, outputTokens: 2, totalTokens: 12 };
          if (method === "session/send") {
            turn++;
            if (turn > 1) event("turn.started", { inputId: params.inputId });
            return { accepted: true };
          }
          if (method === "v4/conversation/rowsRange")
            return {
              rows: historyRows,
              atSeq: seq,
              atRevision: 1,
              atLogEpoch: "epoch-1",
              hasMore: false,
            };
          if (method === "v4/command")
            return {
              commandId: params.commandId,
              status: "accepted",
              result: { type: params.type },
            };
          return {};
        },
        async close() {},
      };
    },
  });
  closes.push(bridge.close);
  async function until(predicate: () => boolean) {
    for (let i = 0; i < 500; i++) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("Timed out waiting for retry probe");
  }
  async function rpc(method: string, params: unknown) {
    const rid = ++id;
    bridge.handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: rid, method, params }),
    );
    await until(() => messages.some((m) => m.id === rid && !m.method));
    return messages.find((m) => m.id === rid && !m.method)!;
  }
  const deltas = () =>
    messages
      .filter((m) => m.method === "thread/delta")
      .flatMap((m) => record(m.params).deltas as Record<string, unknown>[]);
  const providerErrors = () =>
    deltas().filter((d) => d.kind === "provider.error");
  const retryCommands = () =>
    calls.filter(
      (c) => c.method === "v4/command" && c.params.type === "retryTurn",
    );
  async function start() {
    expect(
      (
        await rpc("thread/start", {
          threadId: "thread",
          cwd,
          options,
          instructionMode: "append",
        })
      ).error,
    ).toBeUndefined();
  }
  async function send(text: string) {
    // turn 1 emits its turn.started early from session/send in core tests;
    // here turn 1 stays quiet so tests control every native turn lifecycle.
    const rid = ++id;
    bridge.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: rid,
        method: "turn/start",
        params: {
          threadId: "thread",
          providerThreadId: "native-session",
          options,
          input: [{ type: "text", text, mentions: [] }],
          clientRequestId: "creq_retryabcde",
        },
      }),
    );
    await until(() => messages.some((m) => m.id === rid && !m.method));
    return messages.find((m) => m.id === rid && !m.method)!;
  }
  const failUpstream = (nativeTurnId: string) =>
    event(
      "turn.failed",
      {
        error: {
          type: "model_request_failed",
          code: "model_request_failed",
          message: UPSTREAM_ERROR,
        },
        turnPhase: "model",
      },
      nativeTurnId,
    );
  return {
    rpc,
    bridge,
    calls,
    messages,
    event,
    deltas,
    providerErrors,
    retryCommands,
    start,
    send,
    failUpstream,
    until,
    setRows: (rows: Array<Record<string, unknown>>) => {
      historyRows = rows;
    },
  };
}

it("retries a transient upstream failure through native retryTurn and completes the same bb turn", async () => {
  const h = harness();
  await h.start();
  await h.send("do");
  h.setRows([
    { rowId: 1, entityId: "ent-1", kind: "userInput", state: "complete" },
    {
      rowId: 5,
      entityId: "ent-5",
      kind: "assistantText",
      state: "error",
      actions: { canRetry: true },
    },
  ]);
  h.failUpstream("native-turn-1");
  await h.until(() => h.providerErrors().some((d) => d.willRetry === true));
  await h.until(() => h.retryCommands().length === 1);
  expect(h.retryCommands()[0]!.params.payload).toEqual({
    target: { rowId: 5, entityId: "ent-5" },
  });
  // The retried native turn streams into the still-open bb turn.
  h.event("turn.started", {}, "native-turn-2");
  h.event(
    "model.streaming",
    {
      kind: "text_delta",
      assistantMessageId: "m2",
      partId: "p1",
      delta: "done after retry",
    },
    "native-turn-2",
  );
  h.setRows([
    { rowId: 1, entityId: "ent-1", kind: "userInput", state: "complete" },
    {
      rowId: 6,
      entityId: "ent-6",
      kind: "assistantText",
      state: "complete",
      text: "done after retry",
      actions: { canFork: true },
    },
  ]);
  h.event(
    "turn.completed",
    { resultType: "success", response: "done after retry" },
    "native-turn-2",
  );
  await h.until(() =>
    h
      .deltas()
      .some((d) => d.kind === "turn.boundary" && d.status === "completed"),
  );
  expect(h.deltas().filter((d) => d.kind === "turn.open")).toHaveLength(1);
  expect(h.retryCommands()).toHaveLength(1);
  const retried = h.providerErrors().filter((d) => d.willRetry === true);
  expect(retried).toHaveLength(1);
  expect(retried[0]!.category).toBe("internal");
  expect(retried[0]!.errorInfo).toMatchObject({
    httpStatusCode: null,
    providerCode: "model_request_failed",
  });
});

it("gives up after the configured retries and fails with the original error", async () => {
  const h = harness({ retryDelaysMs: [20, 20] });
  await h.start();
  await h.send("do");
  h.setRows([
    { rowId: 1, entityId: "ent-1", kind: "userInput", state: "complete" },
    {
      rowId: 5,
      entityId: "ent-5",
      kind: "assistantText",
      state: "error",
      actions: { canRetry: true },
    },
  ]);
  h.failUpstream("native-turn-1");
  await h.until(() => h.retryCommands().length === 1);
  h.event("turn.started", {}, "native-turn-2");
  h.failUpstream("native-turn-2");
  await h.until(() => h.retryCommands().length === 2);
  h.event("turn.started", {}, "native-turn-3");
  h.failUpstream("native-turn-3");
  await h.until(() =>
    h.deltas().some((d) => d.kind === "turn.boundary" && d.status === "failed"),
  );
  expect(h.retryCommands()).toHaveLength(2);
  const rows = h.providerErrors();
  expect(rows.filter((d) => d.willRetry === true)).toHaveLength(2);
  expect(
    rows.some(
      (d) => d.willRetry === undefined && /exhausted/.test(String(d.detail)),
    ),
  ).toBe(true);
  const fallback = h
    .deltas()
    .find(
      (d) =>
        d.kind === "item.textClose" && d.text === `ZCode: ${UPSTREAM_ERROR}`,
    );
  expect(fallback).toBeDefined();
});

it("does not retry a transient failure after the turn already ran tools", async () => {
  const h = harness();
  await h.start();
  await h.send("run tools");
  h.event(
    "tool.updated",
    {
      toolCallId: "t1",
      toolName: "Bash",
      kind: "scheduled",
      input: { command: "ls" },
    },
    "native-turn-1",
  );
  h.failUpstream("native-turn-1");
  await h.until(() =>
    h.deltas().some((d) => d.kind === "turn.boundary" && d.status === "failed"),
  );
  expect(h.retryCommands()).toHaveLength(0);
  expect(h.providerErrors()).toHaveLength(1);
  expect(h.providerErrors()[0]!.willRetry).toBeUndefined();
  expect(String(h.providerErrors()[0]!.detail)).toMatch(
    /already streamed output or ran tools/,
  );
});

it("does not retry a transient failure after output already streamed", async () => {
  const h = harness();
  await h.start();
  await h.send("stream some");
  h.event("turn.started", {}, "native-turn-1");
  h.event(
    "model.streaming",
    {
      kind: "text_delta",
      assistantMessageId: "m1",
      partId: "p1",
      delta: "partial answer",
    },
    "native-turn-1",
  );
  h.failUpstream("native-turn-1");
  await h.until(() =>
    h.deltas().some((d) => d.kind === "turn.boundary" && d.status === "failed"),
  );
  expect(h.retryCommands()).toHaveLength(0);
  expect(
    h
      .providerErrors()
      .some((d) =>
        /already streamed output or ran tools/.test(String(d.detail)),
      ),
  ).toBe(true);
});

it("a fast second failure does not trip the first retry's start watcher", async () => {
  // Retry 1 has a short start deadline; retry 2 sleeps long enough that a
  // watcher still bound to the first hold would falsely expire and fail the
  // turn before retry 2 even issued its command.
  const h = harness({ retryDelaysMs: [20, 400], retryStartTimeoutMs: 120 });
  await h.start();
  await h.send("do");
  h.setRows([
    { rowId: 1, entityId: "ent-1", kind: "userInput", state: "complete" },
    {
      rowId: 5,
      entityId: "ent-5",
      kind: "assistantText",
      state: "error",
      actions: { canRetry: true },
    },
  ]);
  h.failUpstream("native-turn-1");
  await h.until(() => h.retryCommands().length === 1);
  // The retried turn starts and immediately fails again, installing the next
  // hold before the first watcher's next poll.
  h.event("turn.started", {}, "native-turn-2");
  h.failUpstream("native-turn-2");
  await h.until(() => h.retryCommands().length === 2);
  h.event("turn.started", {}, "native-turn-3");
  h.event(
    "turn.completed",
    { resultType: "success", response: "recovered" },
    "native-turn-3",
  );
  await h.until(() =>
    h
      .deltas()
      .some((d) => d.kind === "turn.boundary" && d.status === "completed"),
  );
  expect(
    h
      .providerErrors()
      .some((d) => /did not start the retried turn/.test(String(d.detail))),
  ).toBe(false);
});

it("does not retry non-transient failure codes", async () => {
  const h = harness();
  await h.start();
  await h.send("do");
  h.event(
    "turn.failed",
    {
      error: {
        type: "model_context_exceeded",
        code: "model_context_exceeded",
        message: "Model request exceeded the provider context window.",
      },
      turnPhase: "model",
    },
    "native-turn-1",
  );
  await h.until(() =>
    h.deltas().some((d) => d.kind === "turn.boundary" && d.status === "failed"),
  );
  expect(h.retryCommands()).toHaveLength(0);
  expect(h.providerErrors()).toHaveLength(0);
});

it("an interrupt during the retry hold settles interrupted and cancels the automatic retry", async () => {
  const h = harness({ retryDelaysMs: [400, 400] });
  await h.start();
  await h.send("do");
  h.setRows([
    { rowId: 1, entityId: "ent-1", kind: "userInput", state: "complete" },
    {
      rowId: 5,
      entityId: "ent-5",
      kind: "assistantText",
      state: "error",
      actions: { canRetry: true },
    },
  ]);
  h.failUpstream("native-turn-1");
  await h.until(() => h.providerErrors().some((d) => d.willRetry === true));
  expect(
    (
      await h.rpc("thread/stop", {
        threadId: "thread",
        providerThreadId: "native-session",
        activeTurnId: null,
        intent: "interrupt",
      })
    ).error,
  ).toBeUndefined();
  await h.until(() =>
    h
      .deltas()
      .some((d) => d.kind === "turn.boundary" && d.status === "interrupted"),
  );
  // Wait past the retry delay: no retryTurn may ever leave the bridge.
  await new Promise((r) => setTimeout(r, 500));
  expect(h.retryCommands()).toHaveLength(0);
});

it("fails the turn when the retried native turn never starts", async () => {
  const h = harness({ retryDelaysMs: [20, 20], retryStartTimeoutMs: 150 });
  await h.start();
  await h.send("do");
  h.setRows([
    { rowId: 1, entityId: "ent-1", kind: "userInput", state: "complete" },
    {
      rowId: 5,
      entityId: "ent-5",
      kind: "assistantText",
      state: "error",
      actions: { canRetry: true },
    },
  ]);
  h.failUpstream("native-turn-1");
  await h.until(() => h.retryCommands().length === 1);
  // No turn.started ever arrives for the retried turn.
  await h.until(() =>
    h.deltas().some((d) => d.kind === "turn.boundary" && d.status === "failed"),
  );
  expect(h.retryCommands()).toHaveLength(1);
  expect(
    h
      .providerErrors()
      .some((d) => /did not start the retried turn/.test(String(d.detail))),
  ).toBe(true);
});

it("does not retry when the conversation tip is not retryable", async () => {
  const h = harness();
  await h.start();
  await h.send("do");
  // Tip exists but the CLI did not mark it retryable (older CLI or busy tip).
  h.setRows([
    { rowId: 1, entityId: "ent-1", kind: "userInput", state: "complete" },
    { rowId: 5, entityId: "ent-5", kind: "assistantText", state: "error" },
  ]);
  h.failUpstream("native-turn-1");
  await h.until(() =>
    h.deltas().some((d) => d.kind === "turn.boundary" && d.status === "failed"),
  );
  expect(h.retryCommands()).toHaveLength(0);
  expect(
    h.providerErrors().some((d) => /could not start/.test(String(d.detail))),
  ).toBe(true);
});

it("surfaces native api-retry envelope state as reconnect rows", async () => {
  const h = harness();
  await h.start();
  await h.send("do");
  h.event("turn.started", {}, "native-turn-1");
  const apiRetry = {
    kind: "api_retry",
    attempt: 2,
    maxRetries: 10,
    retryDelayMs: 5000,
    errorStatus: 502,
    error: UPSTREAM_ERROR,
  };
  h.event("part.started", {}, "native-turn-1", { apiRetry });
  await h.until(() => h.providerErrors().some((d) => d.willRetry === true));
  // The same attempt repeated on later frames must not duplicate the row.
  h.event("part.delta", { delta: "x" }, "native-turn-1", { apiRetry });
  h.event("part.started", {}, "native-turn-1", {
    apiRetry: { ...apiRetry, attempt: 3 },
  });
  await h.until(() => h.providerErrors().length === 2);
  const rows = h.providerErrors();
  expect(rows.map((d) => String(d.detail))).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/2\/11 in 5 s/),
      expect.stringMatching(/3\/11 in 5 s/),
    ]),
  );
  expect(rows[0]!.errorInfo).toMatchObject({
    httpStatusCode: 502,
    providerCode: null,
  });
  expect(rows[0]!.category).toBe("overloaded");
});
