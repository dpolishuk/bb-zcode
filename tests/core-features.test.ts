import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { threadDeltaNotificationParamsSchema } from "@get-bb/plugin-sdk/provider-bridge";
import { createBridge } from "../src/bridge.js";
import { record } from "../src/protocol.js";
import type { ClientCallbacks } from "../src/client.js";

const options = {
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
  providerOptions: { executable: process.execPath, bbToolsEnabled: true },
  model: "test/model",
};
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closes.splice(0).map((f) => f()));
});

function harness(
  earlyStart = true,
  startupCheck?: (callbacks: ClientCallbacks) => Promise<void>,
) {
  let callbacks: ClientCallbacks,
    seq = 0,
    turn = 0,
    id = 0;
  const messages: Record<string, unknown>[] = [],
    calls: { method: string; params: Record<string, unknown> }[] = [];
  const cwd = mkdtempSync(join(tmpdir(), "bb-zcode-features-"));
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
  function event(type: string, payload: unknown = {}) {
    callbacks.notification({
      method: "session/event",
      params: {
        sessionId: "native-session",
        type,
        payload,
        eventSeq: ++seq,
        turnId: `native-turn-${turn}`,
      },
    });
  }
  const bridge = createBridge({
    write: (m) => messages.push(m),
    accountFactory: () => ({
      async initialize() {},
      async authorize() {
        return { headersApplied: false };
      },
      async authorizeOfficialMcp() {
        return { ok: true, headers: { "X-Fixture": "synthetic" } };
      },
      close() {},
    }),
    clientFactory: (_launch, _cwd, cb) => {
      callbacks = cb;
      return {
        async request(method, raw) {
          const params = record(raw);
          calls.push({ method, params });
          if (method === "session/create") await startupCheck?.(callbacks);
          if (
            method === "session/create" ||
            method === "session/resume" ||
            method === "session/read"
          )
            return snapshot;
          if (method === "session/usage")
            return { inputTokens: 10, outputTokens: 2, totalTokens: 12 };
          if (method === "session/send" || method === "session/compact") {
            if (params.content === "reject")
              throw new Error("Native prompt rejected");
            turn++;
            if (earlyStart) event("turn.started", { inputId: params.inputId });
            return method === "session/compact"
              ? { compact: { state: "accepted" }, snapshot }
              : { accepted: true };
          }
          return {};
        },
        async close() {},
      };
    },
  });
  closes.push(bridge.close);
  async function until(predicate: () => boolean) {
    for (let i = 0; i < 200; i++) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("Timed out waiting for feature probe");
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
  const input = (text: string) => [{ type: "text", text, mentions: [] }];
  const base = {
    threadId: "thread",
    providerThreadId: "native-session",
    options,
  };
  async function start(extra: Record<string, unknown> = {}) {
    expect(
      (
        await rpc("thread/start", {
          threadId: "thread",
          cwd,
          options,
          instructionMode: "append",
          ...extra,
        })
      ).error,
    ).toBeUndefined();
  }
  async function send(text: string, suffix = "abcdefghij") {
    return rpc("turn/start", {
      ...base,
      input: input(text),
      clientRequestId: `creq_${suffix}`,
    });
  }
  async function steer(
    text: string,
    suffix: string,
    expectedTurnId = "native-turn-1",
  ) {
    return rpc("turn/steer", {
      ...base,
      input: input(text),
      clientRequestId: `creq_${suffix}`,
      expectedTurnId,
    });
  }
  return {
    rpc,
    bridge,
    calls,
    messages,
    cwd,
    start,
    send,
    steer,
    event,
    deltas,
    until,
    input,
    base,
    snapshot,
    state: (reason: string) =>
      callbacks.notification({
        method: "state.updated",
        params: { sessionId: "native-session", reason },
      }),
    reverse: (method: string, params: unknown) =>
      callbacks.request(method, params),
    crash: () => callbacks.exit(new Error("Synthetic native crash")),
  };
}

it("delivers queued follow-ups in FIFO order after the running turn completes", async () => {
  const h = harness();
  await h.start();
  await h.send("first");
  expect((await h.steer("second", "abcdefghjm")).error).toBeUndefined();
  expect((await h.steer("third", "abcdefghjn")).error).toBeUndefined();
  expect(
    h.calls
      .filter((c) => c.method === "session/send")
      .map((c) => c.params.content),
  ).toEqual(["first"]);
  h.event("turn.completed", {
    resultType: "success",
    response: "first result",
  });
  await h.until(
    () => h.calls.filter((c) => c.method === "session/send").length === 2,
  );
  h.event("turn.completed", {
    resultType: "success",
    response: "second result",
  });
  await h.until(
    () => h.calls.filter((c) => c.method === "session/send").length === 3,
  );
  h.event("turn.completed", {
    resultType: "success",
    response: "third result",
  });
  await h.until(
    () => h.deltas().filter((d) => d.kind === "turn.boundary").length === 3,
  );
  expect(
    h.calls
      .filter((c) => c.method === "session/send")
      .map((c) => c.params.content),
  ).toEqual(["first", "second", "third"]);
  expect(
    h
      .deltas()
      .filter((d) => d.kind === "input.accepted")
      .map((d) => d.clientRequestId),
  ).toEqual(["creq_abcdefghij", "creq_abcdefghjm", "creq_abcdefghjn"]);
  for (const m of h.messages.filter((m) => m.method === "thread/delta"))
    expect(
      threadDeltaNotificationParamsSchema.safeParse(m.params).success,
    ).toBe(true);
});

it("routes workspace-scoped official MCP authentication outside session-bound interactions", async () => {
  const h = harness();
  await h.start();
  await expect(
    h.reverse("interaction/requestOfficialMcpAuthHeaders", {
      requestId: "r",
      pluginId: "p",
      mcpKey: "m",
      targetOrigin: "https://zcode.z.ai",
      workspace: { workspaceKey: h.cwd, workspacePath: h.cwd },
    }),
  ).resolves.toEqual({ ok: true, headers: { "X-Fixture": "synthetic" } });
});

it("injects configured MCP servers at the native session startup boundary", async () => {
  const h = harness();
  const mcpServers = [
    {
      name: "fixture",
      command: process.execPath,
      args: ["fixture.mjs"],
      env: [],
    },
  ];
  const reply = await h.rpc("thread/start", {
    threadId: "thread",
    cwd: h.cwd,
    instructionMode: "append",
    options: {
      ...options,
      providerOptions: {
        ...options.providerOptions,
        mcpServers: JSON.stringify(mcpServers),
      },
    },
  });
  expect(reply.error).toBeUndefined();
  expect(
    h.calls.find((c) => c.method === "session/create")?.params.mcpServers,
  ).toEqual(mcpServers);
});

it("lets users enable native memory and enhanced search", async () => {
  const h = harness();
  await h.rpc("thread/start", {
    threadId: "thread",
    cwd: h.cwd,
    instructionMode: "append",
    options: {
      ...options,
      providerOptions: {
        ...options.providerOptions,
        memoryEnabled: true,
        nativeSearchEnhancementsEnabled: true,
      },
    },
  });
  expect(
    await h.reverse("session/requestRuntimePreferences", {
      sessionId: "native-session",
    }),
  ).toMatchObject({
    memoryEnabled: true,
    nativeSearchEnhancementsEnabled: true,
  });
});

it("can steer a turn whose native start event arrives after its send acknowledgment", async () => {
  const h = harness(false);
  await h.start();
  await h.send("first");
  const opened = h.deltas().find((d) => d.kind === "turn.open");
  expect(opened).toMatchObject({ kind: "turn.open" });
  h.event("turn.started");
  expect(
    (await h.steer("second", "abcdefghjm", "creq_abcdefghij")).error,
  ).toBeUndefined();
});

it("settles native compaction from its state-update completion when no normal turn event arrives", async () => {
  const h = harness(false);
  await h.start();
  await h.send("/compact");
  h.state("session_compacted");
  await h.until(() => h.deltas().some((d) => d.kind === "turn.boundary"));
  expect(h.deltas().filter((d) => d.kind === "turn.boundary")).toEqual([
    { kind: "turn.boundary", status: "completed" },
  ]);
});

it("returns typed stale-turn recovery after the target turn has completed", async () => {
  const h = harness();
  await h.start();
  await h.send("first");
  h.event("turn.completed", { resultType: "success" });
  await h.until(() => h.deltas().some((d) => d.kind === "turn.boundary"));
  const reply = await h.steer("wrong turn", "abcdefghjm", "other-turn");
  expect(record(record(reply.error).data).recovery).toMatchObject({
    kind: "staleTurn",
    retryable: false,
  });
  expect(h.calls.filter((c) => c.method === "session/send")).toHaveLength(1);
});

it("cancels queued follow-ups when the session is interrupted", async () => {
  const h = harness();
  await h.start();
  await h.send("first");
  expect((await h.steer("must not run", "abcdefghjm")).error).toBeUndefined();
  await h.rpc("thread/stop", {
    ...h.base,
    intent: "interrupt",
    activeTurnId: "native-turn-1",
  });
  h.event("turn.completed", {
    resultType: "success",
    response: "late completion",
  });
  await new Promise((r) => setTimeout(r, 15));
  expect(h.calls.filter((c) => c.method === "session/send")).toHaveLength(1);
  expect(h.deltas().filter((d) => d.kind === "turn.boundary")).toEqual([
    { kind: "turn.boundary", status: "interrupted" },
  ]);
});

it("does not accept a queued prompt rejected by native ZCode", async () => {
  const h = harness();
  await h.start();
  await h.send("first");
  expect((await h.steer("reject", "abcdefghjm")).error).toBeUndefined();
  h.event("turn.completed", { resultType: "success" });
  await h.until(() => h.messages.some((m) => m.method === "error"));
  expect(h.deltas().filter((d) => d.kind === "input.accepted")).toHaveLength(1);
  expect(h.deltas().filter((d) => d.kind === "turn.open")).toHaveLength(1);
});

it("forwards image and file attachment metadata without flattening them into text", async () => {
  const h = harness();
  await h.start();
  const image = join(h.cwd, "picture.png"),
    file = join(h.cwd, "notes.txt");
  writeFileSync(image, Buffer.from("iVBORw0KGgo=", "base64"));
  writeFileSync(file, "attached note");
  const reply = await h.rpc("turn/start", {
    ...h.base,
    clientRequestId: "creq_abcdefghij",
    input: [
      ...h.input("inspect"),
      { type: "localImage", path: image },
      { type: "localFile", path: file, mimeType: "text/plain", name: "Notes" },
    ],
  });
  expect(reply.error).toBeUndefined();
  expect(
    h.calls.find((c) => c.method === "session/send")?.params,
  ).toMatchObject({
    content: "inspect",
    attachments: [
      { kind: "image", localPath: image, filename: "picture.png" },
      {
        kind: "file",
        localPath: file,
        filename: "Notes",
        mimeType: "text/plain",
      },
    ],
  });
});

it("accepts an image-only data-URL prompt", async () => {
  const h = harness();
  await h.start();
  const reply = await h.rpc("turn/start", {
    ...h.base,
    clientRequestId: "creq_abcdefghij",
    input: [{ type: "image", url: "data:image/png;base64,iVBORw0KGgo=" }],
  });
  expect(reply.error).toBeUndefined();
  expect(
    h.calls.find((c) => c.method === "session/send")?.params,
  ).toMatchObject({
    content: "",
    attachments: [
      { kind: "image", mimeType: "image/png", dataBase64: "iVBORw0KGgo=" },
    ],
  });
});

it("routes the builtin compact command to native compaction and settles it", async () => {
  const h = harness();
  await h.start();
  const reply = await h.send("/compact");
  expect(reply.error).toBeUndefined();
  expect(h.calls.some((c) => c.method === "session/compact")).toBe(true);
  expect(h.calls.some((c) => c.method === "session/send")).toBe(false);
  h.event("turn.completed", {
    resultType: "success",
    response: "Context compacted",
  });
  await h.until(() => h.deltas().some((d) => d.kind === "turn.boundary"));
  expect(h.deltas().filter((d) => d.kind === "turn.boundary")).toHaveLength(1);
});

it("reports native usage and context without adding reasoning tokens twice", async () => {
  const h = harness();
  await h.start();
  await h.send("hello");
  h.event("turn.completed", {
    resultType: "success",
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      reasoningTokens: 5,
      cacheReadTokens: 30,
      cacheCreationTokens: 10,
    },
  });
  await h.until(() => h.deltas().some((d) => d.kind === "usage"));
  expect(h.deltas().find((d) => d.kind === "usage")).toMatchObject({
    last: {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      reasoningOutputTokens: 5,
      cacheReadInputTokens: 30,
      cacheWriteInputTokens: 10,
    },
  });
  expect(h.deltas().find((d) => d.kind === "contextWindow")).toMatchObject({
    used: 1234,
    size: 200000,
  });
});

it("does not deliver duplicate client request IDs again after dequeuing", async () => {
  const h = harness();
  await h.start();
  await h.send("first");
  expect((await h.steer("second", "abcdefghjm")).error).toBeUndefined();
  h.event("turn.completed", { resultType: "success" });
  await h.until(
    () => h.calls.filter((c) => c.method === "session/send").length === 2,
  );
  expect(
    (await h.steer("second", "abcdefghjm", "native-turn-2")).error,
  ).toBeUndefined();
  h.event("turn.completed", { resultType: "success" });
  await new Promise((r) => setTimeout(r, 15));
  expect(h.calls.filter((c) => c.method === "session/send")).toHaveLength(2);
});

it("uses native cacheWriteTokens rather than treating cache writes as unreported", async () => {
  const h = harness();
  await h.start();
  await h.send("hello");
  h.event("turn.completed", {
    resultType: "success",
    usage: { inputTokens: 10, outputTokens: 2, cacheWriteTokens: 7 },
  });
  await h.until(() => h.deltas().some((d) => d.kind === "usage"));
  expect(h.deltas().find((d) => d.kind === "usage")).toMatchObject({
    last: { cachedInputTokens: 7, cacheWriteInputTokens: 7 },
  });
});

it("restores cumulative native token totals when a saved session resumes", async () => {
  const h = harness();
  await h.start();
  await h.rpc("thread/stop", {
    ...h.base,
    intent: "release",
    activeTurnId: null,
  });
  await h.rpc("thread/resume", {
    ...h.base,
    cwd: h.cwd,
    instructionMode: "append",
  });
  await h.send("continued");
  h.event("turn.completed", {
    resultType: "success",
    usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 },
  });
  await h.until(() => h.deltas().some((d) => d.kind === "usage"));
  expect(h.deltas().find((d) => d.kind === "usage")).toMatchObject({
    total: { inputTokens: 14, outputTokens: 3, totalTokens: 17 },
  });
});

it("never drains queued work after a child exits during terminal usage refresh", async () => {
  const h = harness();
  await h.start();
  await h.send("first");
  await h.steer("must not run", "abcdefghjm");
  h.event("turn.completed", { resultType: "success" });
  h.crash();
  await new Promise((r) => setTimeout(r, 15));
  expect(h.calls.filter((c) => c.method === "session/send")).toHaveLength(1);
  expect(h.deltas().filter((d) => d.kind === "turn.boundary")).toEqual([
    { kind: "turn.boundary", status: "failed" },
  ]);
});

it("does not replay an accepted turn/start client request", async () => {
  const h = harness();
  await h.start();
  await h.send("first");
  h.event("turn.completed", { resultType: "success" });
  await h.until(() => h.deltas().some((d) => d.kind === "turn.boundary"));
  expect((await h.send("replayed")).error).toBeUndefined();
  expect(h.calls.filter((c) => c.method === "session/send")).toHaveLength(1);
});

it("configures bb skills and exposes original paths on fresh and resumed execution", async () => {
  const h = harness();
  const path = join(h.cwd, "bb-skills");
  mkdirSync(join(path, "review"), { recursive: true });
  writeFileSync(
    join(path, "review", "SKILL.md"),
    "# Review\nRead references/check.md",
  );
  const roots = [
    {
      id: "plugin",
      path,
      skills: [{ name: "review", description: "Review code" }],
    },
  ];
  const init = await h.rpc("initialize", {
    protocolVersion: 1,
    client: { name: "test", version: "1" },
  });
  expect(record(record(init.result).capabilities).skills).toEqual({
    configure: true,
  });
  expect((await h.rpc("skills/configure", { roots })).error).toBeUndefined();
  await h.start();
  await h.send("hello");
  expect(
    h.calls.find((c) => c.method === "session/send")?.params.content,
  ).toContain(join(path, "review", "SKILL.md"));
  h.event("turn.completed", { resultType: "success" });
  await h.until(() => h.deltas().some((d) => d.kind === "turn.boundary"));
  await h.rpc("thread/stop", {
    ...h.base,
    intent: "release",
    activeTurnId: null,
  });
  expect(
    (
      await h.rpc("thread/resume", {
        ...h.base,
        cwd: h.cwd,
        instructionMode: "append",
      })
    ).error,
  ).toBeUndefined();
  await h.send("resumed", "abcdefghjk");
  expect(
    h.calls.filter((c) => c.method === "session/send").at(-1)?.params.content,
  ).toContain(join(path, "review", "SKILL.md"));
});

it("rejects relative roots and traversal skill names", async () => {
  const h = harness();
  for (const root of [
    { id: "x", path: "relative", skills: [] },
    { id: "x", path: h.cwd, skills: [{ name: "../escape", description: "x" }] },
  ])
    expect(
      (await h.rpc("skills/configure", { roots: [root] })).error,
    ).toBeDefined();
});

const bbTool = {
  name: "fixture.echo",
  description: "Echo text from bb",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  presentation: {
    label: { pending: "Echoing", completed: "Echo" },
    icon: { glyph: "Terminal" },
  },
};
async function injectedEndpoint(h: ReturnType<typeof harness>) {
  const servers = h.calls.find((c) => c.method === "session/create")?.params
    .mcpServers as Array<Record<string, unknown>> | undefined;
  const server = servers?.find((s) => s.name === "bb-bridge");
  expect(server, "bb tools must reach native startup").toBeDefined();
  const headers = Object.fromEntries(
    (server!.headers as Array<{ name: string; value: string }>).map((h) => [
      h.name,
      h.value,
    ]),
  );
  return { url: String(server!.url), headers };
}
async function mcp(
  endpoint: { url: string; headers: Record<string, string> },
  method: string,
  params: unknown = {},
) {
  return fetch(endpoint.url, {
    method: "POST",
    headers: { ...endpoint.headers, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

it("forwards injected tool calls to bb and retains text, images and presentation", async () => {
  const h = harness();
  await h.start({ dynamicTools: [bbTool] });
  await h.send("call the tool");
  const endpoint = await injectedEndpoint(h);
  const listing = await (await mcp(endpoint, "tools/list")).json();
  const tool = listing.result.tools[0];
  expect(tool.inputSchema).toEqual(bbTool.inputSchema);
  const pending = mcp(endpoint, "tools/call", {
    name: tool.name,
    arguments: { text: "hello" },
  });
  await h.until(() => h.messages.some((m) => m.method === "item/tool/call"));
  const request = h.messages.find((m) => m.method === "item/tool/call")!;
  expect(record(request.params)).toMatchObject({
    threadId: "thread",
    providerThreadId: "native-session",
    tool: "fixture.echo",
    arguments: { text: "hello" },
  });
  h.bridge.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        success: true,
        contentItems: [
          { type: "inputText", text: "hello" },
          { type: "inputImage", imageUrl: "data:image/png;base64,aGVsbG8=" },
        ],
      },
    }),
  );
  expect((await (await pending).json()).result).toMatchObject({
    isError: false,
    content: [
      { type: "text", text: "hello" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ],
  });
  expect(h.deltas().filter((d) => record(d.item).server === "bb")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "item.open",
        presentation: bbTool.presentation,
      }),
      expect.objectContaining({
        kind: "item.close",
        status: "completed",
        presentation: bbTool.presentation,
      }),
    ]),
  );
});

it("denies unauthenticated MCP access and cancels pending bb calls on stop", async () => {
  const h = harness();
  await h.start({ dynamicTools: [bbTool] });
  await h.send("call tool");
  const endpoint = await injectedEndpoint(h);
  expect((await mcp({ ...endpoint, headers: {} }, "tools/list")).status).toBe(
    401,
  );
  const list = await (await mcp(endpoint, "tools/list")).json();
  const pending = mcp(endpoint, "tools/call", {
    name: list.result.tools[0].name,
    arguments: {},
  });
  await h.until(() => h.messages.some((m) => m.method === "item/tool/call"));
  await h.rpc("thread/stop", {
    ...h.base,
    intent: "interrupt",
    activeTurnId: null,
  });
  expect((await (await pending).json()).result.isError).toBe(true);
  await expect(mcp(endpoint, "tools/list")).rejects.toThrow();
});

it("does not publish denied or duplicate bb tools", async () => {
  const h = harness();
  const duplicate = await h.rpc("thread/start", {
    threadId: "dupe",
    cwd: h.cwd,
    options,
    instructionMode: "append",
    dynamicTools: [bbTool, bbTool],
  });
  expect(duplicate.error).toBeDefined();
  await h.start({ dynamicTools: [bbTool], disallowedTools: [bbTool.name] });
  expect(
    h.calls.filter((c) => c.method === "session/create").at(-1)?.params
      .mcpServers,
  ).toBeUndefined();
});

it("serves validated custom subagent configuration with session scoping", async () => {
  const h = harness();
  const subagents = {
    kind: "ready",
    profiles: [
      {
        name: "reviewer",
        description: "Review",
        source: "user",
        systemPrompt: "Review carefully",
        tools: ["Read"],
        maxTurns: 3,
      },
    ],
    builtInModelSelectionOverrides: {},
    pluginAgentModelSelectionOverrides: {},
  };
  await h.start({
    options: {
      ...options,
      providerOptions: {
        ...options.providerOptions,
        subagents: JSON.stringify(subagents),
      },
    },
  });
  expect(
    await h.reverse("session/requestRuntimePreferences", {
      sessionId: "native-session",
      scope: "runtime-materialization",
    }),
  ).toMatchObject({ subagentRuntimeConfigEnabled: true });
  expect(
    await h.reverse("subagents/readRuntimeConfig", {
      sessionId: "native-session",
    }),
  ).toEqual(subagents);
  await expect(
    h.reverse("subagents/readRuntimeConfig", { sessionId: "other-session" }),
  ).rejects.toThrow("mismatch");
});

it("rejects invalid custom subagents before launching native sessions", async () => {
  const h = harness();
  const reply = await h.rpc("thread/start", {
    threadId: "invalid",
    cwd: h.cwd,
    options: {
      ...options,
      providerOptions: {
        ...options.providerOptions,
        subagents: '{"kind":"ready","profiles":[{"source":"built-in"}]}',
      },
    },
    instructionMode: "append",
  });
  expect(reply.error).toBeDefined();
  expect(h.calls).toHaveLength(0);
});

it("refuses unknown tools and calls outside an active turn", async () => {
  const h = harness();
  await h.start({ dynamicTools: [bbTool] });
  const endpoint = await injectedEndpoint(h);
  const list = await (await mcp(endpoint, "tools/list")).json();
  expect(
    (await (await mcp(endpoint, "tools/call", { name: "unknown" })).json())
      .error.code,
  ).toBe(-32602);
  expect(
    (
      await (
        await mcp(endpoint, "tools/call", { name: list.result.tools[0].name })
      ).json()
    ).result.isError,
  ).toBe(true);
  expect(h.messages.some((m) => m.method === "item/tool/call")).toBe(false);
});

it("maps bb tool failures and suppresses duplicate native MCP rows", async () => {
  const h = harness();
  await h.start({ dynamicTools: [bbTool] });
  await h.send("call tool");
  const endpoint = await injectedEndpoint(h);
  const list = await (await mcp(endpoint, "tools/list")).json();
  const alias = list.result.tools[0].name;
  h.event("tool.updated", {
    kind: "scheduled",
    toolCallId: "native-mcp",
    toolName: `mcp__bb-bridge__${alias}`,
    input: {},
  });
  h.event("tool.updated", { kind: "started", toolCallId: "native-mcp" });
  const pending = mcp(endpoint, "tools/call", { name: alias, arguments: {} });
  await h.until(() => h.messages.some((m) => m.method === "item/tool/call"));
  const request = h.messages.find((m) => m.method === "item/tool/call")!;
  h.bridge.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        success: false,
        contentItems: [{ type: "inputText", text: "fixture failed" }],
      },
    }),
  );
  expect((await (await pending).json()).result).toMatchObject({
    isError: true,
    content: [{ type: "text", text: "fixture failed" }],
  });
  h.event("tool.updated", {
    kind: "result",
    toolCallId: "native-mcp",
    result: { success: true },
  });
  expect(h.deltas().filter((d) => d.kind === "item.open")).toHaveLength(1);
  expect(h.deltas().filter((d) => d.kind === "item.close")).toHaveLength(1);
  for (const message of h.messages.filter((m) => m.method === "thread/delta"))
    expect(
      threadDeltaNotificationParamsSchema.safeParse(message.params).success,
    ).toBe(true);
});

it("closes pending bb tool rows before a crashed session boundary", async () => {
  const h = harness();
  await h.start({ dynamicTools: [bbTool] });
  await h.send("call tool");
  const endpoint = await injectedEndpoint(h);
  const list = await (await mcp(endpoint, "tools/list")).json();
  const pending = mcp(endpoint, "tools/call", {
    name: list.result.tools[0].name,
    arguments: {},
  });
  await h.until(() => h.messages.some((m) => m.method === "item/tool/call"));
  h.crash();
  expect((await (await pending).json()).result.isError).toBe(true);
  const deltas = h.deltas();
  expect(deltas.findIndex((d) => d.kind === "item.close")).toBeLessThan(
    deltas.findIndex((d) => d.kind === "turn.boundary"),
  );
});

it("binds native subagent startup callbacks before the session snapshot arrives", async () => {
  const subagents = { kind: "built-in-fallback" };
  const h = harness(true, async (callbacks) => {
    expect(
      await callbacks.request("subagents/readRuntimeConfig", {
        sessionId: "native-session",
      }),
    ).toEqual(subagents);
    await expect(
      callbacks.request("subagents/readRuntimeConfig", {
        sessionId: "foreign-session",
      }),
    ).rejects.toThrow("mismatch");
  });
  await h.start({
    options: {
      ...options,
      providerOptions: {
        ...options.providerOptions,
        subagents: JSON.stringify(subagents),
      },
    },
  });
});

it("preserves CLI MCP inheritance until the bb tool bridge is enabled", async () => {
  const h = harness();
  await h.start({
    dynamicTools: [bbTool],
    options: { ...options, providerOptions: { executable: process.execPath } },
  });
  expect(
    h.calls.find((c) => c.method === "session/create")?.params.mcpServers,
  ).toBeUndefined();
});
