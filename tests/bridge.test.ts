import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  experimental_runBridgeConformance,
  experimental_formatConformanceReport,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import {
  threadDeltaNotificationParamsSchema,
  interactionRequestPayloadSchema,
  approvalInteractionOutcomeSchema,
} from "@get-bb/plugin-sdk/provider-bridge";
import { createBridge } from "../src/bridge.js";
import { record } from "../src/protocol.js";

const fixture = resolve("tests/fixtures/fake-zcode.mjs");
const options = {
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
  providerOptions: { executable: fixture, nodeExecutable: process.execPath },
  model: "test/model",
};
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});
function harness(extra: Parameters<typeof createBridge>[0] = {}) {
  const messages: Record<string, unknown>[] = [];
  const bridge = createBridge({
    ...extra,
    write: (message) => messages.push(message),
    env: {
      ...process.env,
      BB_ZCODE_EXECUTABLE: fixture,
      BB_ZCODE_NODE_EXECUTABLE: process.execPath,
    },
  });
  cleanup.push(bridge.close);
  const cwd = mkdtempSync(join(tmpdir(), "bb-zcode-test-"));
  let nextId = 0;
  async function until(predicate: () => boolean, timeout = 5000) {
    const end = Date.now() + timeout;
    while (!predicate()) {
      if (Date.now() > end)
        throw new Error("Timed out waiting for bridge output");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  async function rpc(method: string, params: unknown) {
    const id = ++nextId;
    bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    await until(() => messages.some((m) => m.id === id && !m.method));
    return messages.find((m) => m.id === id && !m.method)!;
  }
  async function start() {
    const reply = await rpc("thread/start", {
      threadId: "thread",
      cwd,
      options,
      instructionMode: "append",
    });
    expect(reply.error).toBeUndefined();
    return String(record(reply.result).providerThreadId);
  }
  const deltas = () =>
    messages
      .filter((m) => m.method === "thread/delta")
      .flatMap(
        (m) => record(m.params).deltas as Array<Record<string, unknown>>,
      );
  return { bridge, messages, rpc, start, until, cwd, deltas };
}

it("passes bb canonical bridge conformance using a real child process and synthetic ZCode peer", async () => {
  const h = harness();
  const report = await experimental_runBridgeConformance({
    transport: {
      send: h.bridge.handleLine,
      takeMessages: () => h.messages.splice(0),
    },
    providerId: "zcode",
    session: {
      cwd: h.cwd,
      promptInput: [{ type: "text", text: "hello", mentions: [] }],
      zeroWorkPromptInput: [{ type: "text", text: "/noop", mentions: [] }],
    },
    timeoutMs: 5000,
  });
  expect(report.passed, experimental_formatConformanceReport(report)).toBe(
    true,
  );
}, 30_000);

it.each(["hello", "early", "/noop"])(
  "settles %s once, with acceptance before timeline events",
  async (prompt) => {
    const h = harness();
    const providerThreadId = await h.start();
    const reply = await h.rpc("turn/start", {
      threadId: "thread",
      providerThreadId,
      options,
      clientRequestId: "creq_abcdefghij",
      input: [{ type: "text", text: prompt, mentions: [] }],
    });
    expect(reply.error).toBeUndefined();
    await h.until(() => h.deltas().some((d) => d.kind === "turn.boundary"));
    const deltas = h.deltas();
    expect(deltas.filter((d) => d.kind === "turn.open")).toHaveLength(1);
    expect(deltas.filter((d) => d.kind === "turn.boundary")).toHaveLength(1);
    expect(deltas.findIndex((d) => d.kind === "input.accepted")).toBeLessThan(
      deltas.findIndex((d) => d.kind === "turn.open"),
    );
    for (const message of h.messages.filter((m) => m.method === "thread/delta"))
      expect(
        threadDeltaNotificationParamsSchema.safeParse(message.params).success,
      ).toBe(true);
  },
);

it("does not acknowledge a rejected input or invent a turn", async () => {
  const h = harness();
  const providerThreadId = await h.start();
  const reply = await h.rpc("turn/start", {
    threadId: "thread",
    providerThreadId,
    options,
    clientRequestId: "creq_abcdefghij",
    input: [{ type: "text", text: "reject", mentions: [] }],
  });
  expect(reply.error).toBeDefined();
  expect(
    h
      .deltas()
      .some((d) => d.kind === "turn.open" || d.kind === "input.accepted"),
  ).toBe(false);
});

it("keeps personal API sessions usable when Coding Plan is unavailable", async () => {
  const h = harness({
    accountFactory: () => ({
      async initialize() {
        throw new Error("ZCode Coding Plan: subscription unavailable.");
      },
      async authorize() {
        return { headersApplied: false };
      },
      close() {},
    }),
  });
  const providerThreadId = await h.start();
  const reply = await h.rpc("turn/start", {
    threadId: "thread",
    providerThreadId,
    options,
    clientRequestId: "creq_abcdefghij",
    input: [{ type: "text", text: "hello", mentions: [] }],
  });
  expect(reply.error).toBeUndefined();
  await h.until(() => h.deltas().some((d) => d.kind === "turn.boundary"));
  expect(h.deltas().find((d) => d.kind === "turn.boundary")?.status).toBe(
    "completed",
  );
});

it.each(["allow_once", "deny"])(
  "round-trips a %s permission decision without granting session-wide access",
  async (decision) => {
    const h = harness();
    const providerThreadId = await h.start();
    await h.rpc("turn/start", {
      threadId: "thread",
      providerThreadId,
      options,
      clientRequestId: "creq_abcdefghij",
      input: [{ type: "text", text: "permission", mentions: [] }],
    });
    await h.until(() =>
      h.messages.some((m) => m.method === "interaction/request"),
    );
    const request = h.messages.find((m) => m.method === "interaction/request")!;
    const payload = record(request.params).payload;
    expect(
      approvalInteractionOutcomeSchema.shape.payload.safeParse(payload).success,
    ).toBe(true);
    expect(record(payload).availableDecisions).toEqual(["allow_once", "deny"]);
    h.bridge.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: { decision, grantedPermissions: null },
      }),
    );
    await h.until(() => h.deltas().some((d) => d.kind === "turn.boundary"));
    expect(
      h
        .deltas()
        .some(
          (d) =>
            d.kind === "item.textClose" &&
            d.text === (decision === "deny" ? "deny" : "allow"),
        ),
    ).toBe(true);
  },
);

it("maps a native question and answer", async () => {
  const h = harness();
  const providerThreadId = await h.start();
  await h.rpc("turn/start", {
    threadId: "thread",
    providerThreadId,
    options,
    clientRequestId: "creq_abcdefghij",
    input: [{ type: "text", text: "question", mentions: [] }],
  });
  await h.until(() =>
    h.messages.some((m) => m.method === "interaction/request"),
  );
  const request = h.messages.find((m) => m.method === "interaction/request")!;
  expect(
    interactionRequestPayloadSchema.safeParse(record(request.params).payload)
      .success,
  ).toBe(true);
  h.bridge.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: { kind: "user_answer", answers: { q0: { selected: ["a"] } } },
    }),
  );
  await h.until(() => h.deltas().some((d) => d.kind === "turn.boundary"));
  expect(
    h
      .deltas()
      .some(
        (d) =>
          typeof d.text === "string" && d.text.includes('"Which one?":"a"'),
      ),
  ).toBe(true);
});

it("settles interruption before replying, releases the child, and cold-resumes the same session", async () => {
  const h = harness();
  const providerThreadId = await h.start();
  await h.rpc("turn/start", {
    threadId: "thread",
    providerThreadId,
    options,
    clientRequestId: "creq_abcdefghij",
    input: [{ type: "text", text: "hang", mentions: [] }],
  });
  const stop = await h.rpc("thread/stop", {
    threadId: "thread",
    providerThreadId,
    intent: "interrupt",
    activeTurnId: null,
  });
  expect(stop.error).toBeUndefined();
  expect(h.deltas().filter((d) => d.kind === "turn.boundary")).toEqual([
    { kind: "turn.boundary", status: "interrupted" },
  ]);
  const terminal = h.messages.findIndex(
    (m) =>
      m.method === "thread/delta" &&
      (record(m.params).deltas as Array<Record<string, unknown>>).some(
        (d) => d.kind === "turn.boundary",
      ),
  );
  expect(terminal).toBeLessThan(h.messages.indexOf(stop));
  const resumed = await h.rpc("thread/resume", {
    threadId: "thread",
    providerThreadId,
    cwd: h.cwd,
    options,
    instructionMode: "append",
  });
  expect(record(resumed.result).providerThreadId).toBe(providerThreadId);
});

it("fails a running turn on child exit", async () => {
  const h = harness();
  const providerThreadId = await h.start();
  await h.rpc("turn/start", {
    threadId: "thread",
    providerThreadId,
    options,
    clientRequestId: "creq_abcdefghij",
    input: [{ type: "text", text: "crash", mentions: [] }],
  });
  await h.until(() => h.deltas().some((d) => d.kind === "turn.boundary"));
  expect(h.deltas().find((d) => d.kind === "turn.boundary")?.status).toBe(
    "failed",
  );
});

it("rejects a mismatched provider identity", async () => {
  const h = harness();
  await h.start();
  const reply = await h.rpc("thread/stop", {
    threadId: "thread",
    providerThreadId: "wrong",
    intent: "release",
    activeTurnId: null,
  });
  expect(record(reply.error).code).toBe(-32602);
});

it("reports provider usage with the account plan label", async () => {
  const h = harness({
    accountFactory: () => ({
      planLabel: "Coding Plan Fixture",
      async initialize() {},
      async authorize() {
        return { headersApplied: false };
      },
      close() {},
    }),
  });
  const r = await h.rpc("provider/usage", { providerId: "zcode" });
  expect(record(r.result)).toMatchObject({
    supported: true,
    usage: {
      status: "ok",
      planLabel: "Coding Plan Fixture",
      accountEmail: null,
      windows: [],
    },
  });
});
