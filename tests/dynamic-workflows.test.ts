import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createBridge } from "../src/bridge.js";
import { record } from "../src/protocol.js";
import { runtimeSettings } from "../src/settings.js";
import type { ClientCallbacks } from "../src/client.js";

const workflowOptions = (enabled: boolean) => ({
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
  providerOptions: {
    executable: process.execPath,
    dynamicWorkflowsEnabled: enabled,
  },
});

it("runtimeSettings defaults dynamic workflows off and honors the setting", () => {
  expect(runtimeSettings({}).dynamicWorkflowsEnabled).toBe(false);
  expect(
    runtimeSettings({ dynamicWorkflowsEnabled: true }).dynamicWorkflowsEnabled,
  ).toBe(true);
  // Truthy junk must not leak through as enabled.
  expect(
    runtimeSettings({ dynamicWorkflowsEnabled: "yes" }).dynamicWorkflowsEnabled,
  ).toBe(false);
});

function harness() {
  const cwd = mkdtempSync(join(tmpdir(), "bb-zcode-dwf-bridge-"));
  const messages: Record<string, unknown>[] = [];
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let serial = 0;
  const bridge = createBridge({
    write: (m) => messages.push(m),
    accountFactory: () => ({
      async initialize() {},
      async authorize() {
        return { headersApplied: false };
      },
      close() {},
    }),
    clientFactory: (_launch, _cwd, cb: ClientCallbacks) => {
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
            return snapshot();
          }
          if (method === "session/resume") {
            nativeId = String(p.sessionId);
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
          if (method === "session/usage") return { turns: [], totals: {} };
          throw new Error(`Unexpected native method: ${method}`);
        },
        async close() {},
      };
    },
  });
  let rid = 0;
  const rpc = async (method: string, params: unknown) => {
    const id = ++rid;
    bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    while (!messages.some((m) => m.id === id && !m.method))
      await new Promise((resolve) => setTimeout(resolve, 5));
    return record(messages.find((m) => m.id === id && !m.method));
  };
  return { bridge, calls, cwd, rpc };
}

it("sends an explicit dynamic-workflow gate on session create", async () => {
  const { bridge, calls, cwd, rpc } = harness();
  await rpc("thread/start", {
    threadId: "thread",
    cwd,
    options: workflowOptions(true),
    instructionMode: "replace",
  });
  const create = calls.find((c) => c.method === "session/create")!;
  expect(create.params.dynamicWorkflowEnabled).toBe(true);
  await bridge.close();
});

it("omits the gate param when off: fail-closed and 0.16.9-safe", async () => {
  const { bridge, calls, cwd, rpc } = harness();
  await rpc("thread/start", {
    threadId: "thread",
    cwd,
    options: workflowOptions(false),
    instructionMode: "replace",
  });
  const create = calls.find((c) => c.method === "session/create")!;
  // The native gate resolves an absent param to disabled (its workspace
  // policy defaults to off and the bridge never syncs one), and older
  // supported CLIs validate create/resume params strictly - an explicit
  // false would be an unknown field there.
  expect("dynamicWorkflowEnabled" in create.params).toBe(false);
  await bridge.close();
});

it("repeats the gate on thread resume so cold recovery keeps the tool family", async () => {
  const { bridge, calls, cwd, rpc } = harness();
  await rpc("thread/resume", {
    threadId: "thread",
    providerThreadId: "native-9",
    cwd,
    options: workflowOptions(true),
    instructionMode: "replace",
  });
  const resume = calls.find((c) => c.method === "session/resume")!;
  expect(resume.params.dynamicWorkflowEnabled).toBe(true);
  expect(resume.params.sessionId).toBe("native-9");
  await bridge.close();
});
