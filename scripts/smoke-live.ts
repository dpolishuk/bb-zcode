import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZCodeClient, ProtocolError } from "../src/client.js";
import { resolveLaunch, workspaceRef } from "../src/launch.js";
import { RUNTIME_PREFERENCES, record } from "../src/protocol.js";
import { createBridge } from "../src/bridge.js";

// Opt-in real CLI test against a deterministic loopback model, with no credentials.
const root = mkdtempSync(join(tmpdir(), "bb-zcode-live-"));
const cwd = join(root, "workspace");
mkdirSync(cwd);
let modelRequests = 0;
const modelServer = createServer(async (request, response) => {
  for await (const _chunk of request) {
    /* drain; never record model input */
  }
  modelRequests++;
  response.writeHead(200, { "content-type": "text/event-stream" });
  const event = (type: string, data: unknown) =>
    response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  event("message_start", {
    type: "message_start",
    message: {
      id: "msg_fixture",
      type: "message",
      role: "assistant",
      model: "fixture",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  });
  event("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  event("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "Hello from the local fixture." },
  });
  event("content_block_stop", { type: "content_block_stop", index: 0 });
  event("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 7 },
  });
  event("message_stop", { type: "message_stop" });
  response.end();
});
await new Promise<void>((resolve) =>
  modelServer.listen(0, "127.0.0.1", resolve),
);
const address = modelServer.address();
if (!address || typeof address === "string")
  throw new Error("No loopback listener.");
const builtinFile = join(root, "builtin.json");
writeFileSync(
  builtinFile,
  JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    config: {
      providerConfigRules: {
        providerRules: [],
        templateRules: [
          {
            templateId: "bb-fixture",
            templateNameMap: { "en-US": "Local fixture" },
            config: {
              access: { type: "api-key" },
              api: {
                type: "anthropic-messages",
                baseUrl: `http://127.0.0.1:${address.port}`,
              },
              builtinModelIds: ["fixture"],
            },
          },
        ],
      },
      modelConfigRules: {
        modelRules: [],
        modelApiRules: [],
        providerSiteRules: [],
        builtinProviderModelRules: [],
        templateModelRules: [
          {
            templateId: "bb-fixture",
            modelId: "fixture",
            config: {
              enabled: true,
              properties: {
                requiresMfjsToolSchema: false,
                contextWindow: 200000,
                inputFormat: {
                  supportsText: true,
                  supportsImage: false,
                  supportsVideo: false,
                  supportsAudio: false,
                  supportsPdf: false,
                },
                outputFormat: { supportsText: true },
                supportsToolCall: true,
                supportsJsonSchemaOutput: true,
                supportsNativeWebSearch: false,
                supportsMidConversationSystem: false,
              },
              optionSpecs: {
                reasoningLevel: { values: ["disabled"], map: "{}" },
                maxOutputTokens: {
                  max: 4096,
                  map: "{'max_tokens': maxOutputTokens}",
                },
              },
            },
          },
        ],
      },
    },
  }),
);
const model = {
  providerId: "bb-smoke",
  modelId: "fixture",
  options: { reasoningLevel: "disabled" },
};
writeFileSync(
  join(root, "personal.json"),
  JSON.stringify({
    schemaVersion: 1,
    config: {
      providerConfigRules: {
        providerRules: [
          {
            providerId: "bb-smoke",
            providerName: "Local fixture",
            templateId: "bb-fixture",
            config: {
              group: "standard-personal",
              access: { type: "api-key", apiKey: "local-fixture-no-secret" },
            },
          },
        ],
      },
      modelConfigRules: {
        providerModelRules: [],
        manualProviderModelRules: [],
      },
      defaultModelSelection: model,
    },
  }),
);
mkdirSync(join(root, ".zcode", "cli"), { recursive: true });
writeFileSync(
  join(root, ".zcode", "cli", "config.json"),
  JSON.stringify({ mcp: { enabled: false }, plugins: { enabled: false } }),
);
const env: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: root,
  ZCODE_HOME: join(root, ".zcode", "cli"),
  ZCODE_DATA_BASE_DIR: root,
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: join(root, "personal.json"),
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinFile,
};
const launch = resolveLaunch({}, env);
let terminal: Record<string, unknown> | undefined;
let streamed = "";
const callbacks = {
  notification(frame: import("../src/client.js").Frame) {
    if (frame.method !== "session/event") return;
    const event = record(frame.params);
    const payload = record(event.payload);
    if (event.type === "model.streaming" && payload.kind === "text_delta")
      streamed += payload.delta;
    if (event.type === "turn.completed" || event.type === "turn.failed")
      terminal = { type: event.type, ...payload };
  },
  async request(method: string) {
    if (method === "session/requestRuntimePreferences")
      return RUNTIME_PREFERENCES;
    throw new ProtocolError(`Unsupported test callback: ${method}`, -32601);
  },
  exit() {},
};
let client = new ZCodeClient(launch, cwd, callbacks);
try {
  const created = record(
    await client.request("session/create", {
      workspace: workspaceRef(cwd),
      mode: "build",
      model,
      persistence: "immediate",
      titleGenerationEnabled: false,
    }),
  );
  const sessionId = record(created.session).sessionId;
  if (typeof sessionId !== "string")
    throw new Error(
      `Unexpected session shape: ${Object.keys(record(created.session)).join(", ")}`,
    );
  await client.request("session/subscribe", {
    sessionId,
    deliveryKind: "desktop-continuous",
    includeSnapshot: false,
  });
  await client.request("session/setMode", { sessionId, mode: "plan" });
  await client.request("session/send", {
    sessionId,
    inputId: "fixture-input",
    modelSelection: model,
    content: "Reply with a short greeting. Do not call tools.",
  });
  const deadline = Date.now() + 30_000;
  while (!terminal && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  if (!terminal || terminal.resultType !== "success")
    throw new Error(`Real CLI turn failed: ${JSON.stringify(terminal)}`);
  if (streamed !== "Hello from the local fixture." || modelRequests < 1)
    throw new Error("Real CLI did not stream the fixture response.");
  await client.close();
  client = new ZCodeClient(launch, cwd, callbacks);
  const resumed = record(
    await client.request("session/resume", {
      sessionId,
      workspace: workspaceRef(cwd),
    }),
  );
  if (record(resumed.session).sessionId !== sessionId)
    throw new Error("Resume changed the session identity.");
  await client.close();
  const messages: Record<string, unknown>[] = [];
  const bridge = createBridge({
    env,
    write: (message) => messages.push(message),
  });
  let nextId = 0;
  const waitFor = async (predicate: () => boolean) => {
    const end = Date.now() + 30_000;
    while (!predicate()) {
      if (Date.now() > end) throw new Error("Bridge smoke timed out.");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const rpc = async (method: string, params: unknown) => {
    const id = ++nextId;
    bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    await waitFor(() => messages.some((m) => m.id === id && !m.method));
    const response = messages.find((m) => m.id === id && !m.method)!;
    if (response.error)
      throw new Error(`Bridge ${method}: ${JSON.stringify(response.error)}`);
    return record(response.result);
  };
  const options = {
    permissionMode: "full",
    permissionScope: "full",
    approvalReviewer: null,
    permissionEscalation: null,
    model: "bb-smoke/fixture",
  };
  try {
    const start = await rpc("thread/start", {
      threadId: "live-smoke",
      cwd,
      options,
      instructionMode: "append",
    });
    if (start.sessionRestorable !== false)
      throw new Error(
        "An empty ZCode session must not be advertised as durable.",
      );
    await rpc("turn/start", {
      threadId: "live-smoke",
      providerThreadId: start.providerThreadId,
      options,
      clientRequestId: "creq_abcdefghij",
      input: [
        {
          type: "text",
          text: "Reply with a short greeting. Do not call tools.",
          mentions: [],
        },
      ],
    });
    const deltas = () =>
      messages
        .filter((m) => m.method === "thread/delta")
        .flatMap(
          (m) => record(m.params).deltas as Array<Record<string, unknown>>,
        );
    await waitFor(() => deltas().some((d) => d.kind === "turn.boundary"));
    if (
      deltas().find((d) => d.kind === "turn.boundary")?.status !== "completed"
    )
      throw new Error(`Bridge turn failed: ${JSON.stringify(deltas())}`);
    if (
      deltas()
        .filter((d) => d.kind === "item.textDelta")
        .map((d) => d.text)
        .join("") !== "Hello from the local fixture."
    )
      throw new Error("Bridge did not forward streamed text.");
    await rpc("thread/stop", {
      threadId: "live-smoke",
      providerThreadId: start.providerThreadId,
      intent: "release",
      activeTurnId: null,
    });
    const resumedBridge = await rpc("thread/resume", {
      threadId: "live-smoke",
      providerThreadId: start.providerThreadId,
      cwd,
      options,
      instructionMode: "append",
    });
    if (resumedBridge.providerThreadId !== start.providerThreadId)
      throw new Error("Bridge resume changed identity.");
  } finally {
    await bridge.close();
  }
  let bbThreadVerified = false;
  // Point this ONLY at a disposable bb instance. Ordinary runs do not install or reconfigure bb.
  if (process.env.BB_SMOKE_SERVER_URL) {
    if (!process.env.BB_SMOKE_DATA_DIR)
      throw new Error(
        "BB_SMOKE_DATA_DIR is required for the disposable bb check.",
      );
    const wrapper = join(root, "launch-zcode.mjs");
    const fixtureEnv = Object.fromEntries(
      [
        "HOME",
        "ZCODE_HOME",
        "ZCODE_DATA_BASE_DIR",
        "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE",
        "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
      ].map((key) => [key, env[key]]),
    );
    writeFileSync(
      wrapper,
      `import { spawn } from 'node:child_process';\nconst child = spawn(${JSON.stringify(launch.command)}, ${JSON.stringify(launch.args)}, {stdio:'inherit', env:{...process.env,...${JSON.stringify(fixtureEnv)}}});\nchild.on('error', () => {process.exitCode=1;});\nchild.on('exit', code => {process.exitCode=code??1;});\n`,
    );
    const cli = async (...args: string[]) => {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ["scripts/bb.mjs", ...args],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            BB_SERVER_URL: process.env.BB_SMOKE_SERVER_URL,
            BB_DATA_DIR: process.env.BB_SMOKE_DATA_DIR,
            BB_TELEMETRY: "false",
          },
          timeout: 45_000,
          maxBuffer: 2 * 1024 * 1024,
        },
      );
      return JSON.parse(stdout);
    };
    await cli(
      "plugin",
      "config",
      "zcode",
      "set",
      "executable",
      wrapper,
      "--json",
    );
    const models = await cli("provider", "models", "zcode", "--json");
    if (
      !Array.isArray(models) ||
      !models.some((m) => m.model === "bb-smoke/fixture")
    )
      throw new Error("bb did not receive the native model catalog.");
    const project = await cli(
      "project",
      "create",
      "--name",
      "ZCode isolated smoke",
      "--root",
      cwd,
      "--json",
    );
    const thread = await cli(
      "thread",
      "create",
      "--project",
      textForId(project.id),
      "--provider",
      "zcode",
      "--model",
      "bb-smoke/fixture",
      "--environment",
      cwd,
      "--permission-mode",
      "full",
      "--prompt",
      "Reply with a short greeting. Do not call tools.",
      "--title",
      "ZCode isolated integration smoke",
      "--json",
    );
    const threadId = textForId(thread.id);
    await cli(
      "thread",
      "wait",
      threadId,
      "--event",
      "turn/completed",
      "--timeout",
      "30s",
      "--json",
    );
    const output = await cli("thread", "output", threadId, "--json");
    if (output.output !== "Hello from the local fixture.")
      throw new Error(
        `bb did not retain the fixture output: ${JSON.stringify(output)}`,
      );
    bbThreadVerified = true;
  }
  console.log(
    JSON.stringify(
      {
        status: "RUNTIME_VERIFIED",
        checks: [
          "create",
          "subscribe",
          "setMode",
          "real CLI turn with loopback model",
          "streamed text",
          "process shutdown",
          "cold resume",
        ],
        bridgeChecks: [
          "text prompt",
          "native default reasoning",
          "bb streamed deltas",
          "empty-session durability",
          "release",
          "cold resume",
        ],
        protocol: created.protocol,
        modelCount:
          (record(record(created.settings).model).available as unknown[])
            ?.length ?? 0,
        modelRequests,
        bbThreadVerified,
        modelBackend: "synthetic loopback fixture",
        realProviderAuthenticationTested: false,
        isolatedDataDir: root,
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
  modelServer.closeAllConnections();
  await new Promise<void>((resolve) => modelServer.close(() => resolve()));
}

function textForId(value: unknown): string {
  if (typeof value !== "string" || !value)
    throw new Error("bb did not return a thread id.");
  return value;
}
