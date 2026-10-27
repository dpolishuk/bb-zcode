// POC: drive the installed ZCode CLI with the dynamic-workflow gate enabled,
// launch a two-phase workflow through the model tools, and record the full
// host-visible surface: registered tools, approval reverse RPCs, session
// events, the create_workflow display payload, and the workflows/runs read
// API. Deterministic loopback model, no credentials, isolated data dir.
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZCodeClient, ProtocolError, type Frame } from "../src/client.js";
import { resolveLaunch, workspaceRef } from "../src/launch.js";
import { RUNTIME_PREFERENCES, record, text } from "../src/protocol.js";

const root = mkdtempSync(join(tmpdir(), "bb-zcode-dwf-poc-"));
const cwd = join(root, "workspace");
mkdirSync(cwd);
const logPath = "/tmp/dwf-poc-events.jsonl";
writeFileSync(logPath, "");
const log = (kind: string, value: unknown) => {
  appendFileSync(logPath, `${JSON.stringify({ kind, value })}\n`);
  console.log(kind, JSON.stringify(value).slice(0, 300));
};

const POC_SCRIPT = `const meta = {
  name: "poc-two-phase",
  description: "POC two-phase workflow",
  phases: [{ id: "first" }, { id: "second" }],
};
phase("first");
const a = await agent("one").ask("Reply with exactly ONE_OK.");
phase("second");
const b = await agent("two").ask("Reply with exactly TWO_OK.");
log("workflow done: " + a + " " + b);
`;

let modelRequests = 0;
let workflowToolCalls = 0;
let skillToolCalls = 0;
let toolCatalog: string[] = [];
let sawApproval = false;
let sawRunNotification = false;
const eventTypes = new Map<string, number>();
const displayPayloads: unknown[] = [];

const modelServer = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  const tools = Array.isArray(body.tools) ? body.tools.map(record) : [];
  if (toolCatalog.length === 0 && tools.length > 0) {
    toolCatalog = tools.map((t) => String(t.name));
    log("model.toolCatalog", { count: toolCatalog.length, names: toolCatalog });
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const allText = JSON.stringify(messages);
  const lastMessage = JSON.stringify(messages.at(-1) ?? {});
  const hasSkillLoaded =
    /"name":"Skill"/.test(allText) &&
    /dynamic-workflows/.test(allText) &&
    lastMessage.includes('"tool_result"');
  modelRequests++;

  const toolCall = (() => {
    // Main POC conversation: load the skill gate, then create the workflow.
    if (allText.includes("BB_WF_POC")) {
      if (!hasSkillLoaded && skillToolCalls === 0) {
        skillToolCalls++;
        return { name: "Skill", input: { skill: "dynamic-workflows" } };
      }
      if (hasSkillLoaded && workflowToolCalls === 0) {
        workflowToolCalls++;
        return { name: "CreateWorkflow", input: { script: POC_SCRIPT } };
      }
      return undefined;
    }
    // Workflow child agents answer with their canned markers.
    return undefined;
  })();

  const textResponse =
    allText.includes("ONE_OK") && !allText.includes("BB_WF_POC")
      ? "ONE_OK"
      : allText.includes("TWO_OK") && !allText.includes("BB_WF_POC")
        ? "TWO_OK"
        : "WF_POC_MAIN_DONE";

  // Child-agent turns are delayed so the stage 9 v2 probes can observe the
  // run while it is still active (running rows, live workspace nodes).
  if (!allText.includes("BB_WF_POC"))
    await new Promise((resolve) => setTimeout(resolve, 6000));
  await new Promise((resolve) => setTimeout(resolve, 50));
  response.writeHead(200, { "content-type": "text/event-stream" });
  const event = (type: string, data: unknown) =>
    response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  event("message_start", {
    type: "message_start",
    message: {
      id: `msg_fixture_${modelRequests}`,
      type: "message",
      role: "assistant",
      model: "fixture",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  });
  if (toolCall) {
    log("model.emitsToolCall", { name: toolCall.name });
    event("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: `fixture_tool_call_${modelRequests}`,
        name: toolCall.name,
        input: {},
      },
    });
    event("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify(toolCall.input),
      },
    });
    event("content_block_stop", { type: "content_block_stop", index: 0 });
    event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 7 },
    });
  } else {
    event("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    event("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: textResponse },
    });
    event("content_block_stop", { type: "content_block_stop", index: 0 });
    event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 7 },
    });
  }
  event("message_stop", { type: "message_stop" });
  response.end();
});
await new Promise<void>((resolve) =>
  modelServer.listen(0, "127.0.0.1", resolve),
);
const address = modelServer.address();
if (!address || typeof address === "string") throw new Error("No listener.");
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
                contextWindow: 1000000,
                inputFormat: {
                  supportsText: true,
                  supportsImage: true,
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
                reasoningLevel: {
                  values: ["disabled", "low", "medium", "high"],
                  map: '{"output_config": {"effort": reasoningLevel}}',
                },
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
  providerId: "bb-poc",
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
            providerId: "bb-poc",
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
const callbacks = {
  notification(frame: Frame) {
    log("notify", { method: frame.method });
    if (frame.method !== "session/event") return;
    const event = record(frame.params);
    const payload = record(event.payload);
    eventTypes.set(
      String(event.type),
      (eventTypes.get(String(event.type)) ?? 0) + 1,
    );
    log("event", {
      type: event.type,
      payloadKeys: Object.keys(payload),
      payload: JSON.stringify(payload).slice(0, 2000),
    });
    if (JSON.stringify(payload).includes("create_workflow")) {
      displayPayloads.push(payload);
      log("display.create_workflow", payload);
    }
    if (JSON.stringify(payload).includes("task-notification"))
      sawRunNotification = true;
    if (event.type === "turn.completed" || event.type === "turn.failed")
      terminal = { type: event.type, ...payload };
  },
  async request(method: string, params: unknown) {
    log("hostRequest", {
      method,
      params: JSON.stringify(params).slice(0, 1500),
    });
    if (method === "session/requestRuntimePreferences")
      return RUNTIME_PREFERENCES;
    if (method === "interaction/requestPermission") {
      sawApproval = true;
      return { decision: "allow" };
    }
    throw new ProtocolError(`POC: unhandled callback ${method}`, -32601);
  },
  exit() {},
};

const client = new ZCodeClient(launch, cwd, callbacks);
const created = record(
  await client.request("session/create", {
    workspace: workspaceRef(cwd),
    mode: "build",
    model,
    persistence: "immediate",
    titleGenerationEnabled: false,
    dynamicWorkflowEnabled: true,
  } as Record<string, unknown>),
);
const sessionId = record(created.session).sessionId as string;
log("session.created", { sessionId });
await client.request("session/subscribe", {
  sessionId,
  deliveryKind: "desktop-continuous",
  includeSnapshot: false,
});
await client.request("session/send", {
  sessionId,
  inputId: "poc-input",
  modelSelection: model,
  content:
    "BB_WF_POC Run a workflow for this POC: load the dynamic-workflows skill, then call CreateWorkflow with the prepared script.",
});

const runTerminal = async (): Promise<Record<string, unknown> | undefined> => {
  try {
    const runs = record(
      await client.request("workflows/runs", {
        workspace: workspaceRef(cwd),
        limit: 10,
      } as Record<string, unknown>),
    );
    const list = Array.isArray(runs.runs) ? runs.runs.map(record) : [];
    for (const run of list)
      log("workflows.runs.row", {
        runId: run.runId,
        status: run.status,
        name: run.name,
        parentSessionId: run.parentSessionId,
        spentTokens: run.spentTokens,
        artifacts: run.artifacts,
      });
    return list.find(
      (run) =>
        run.status === "completed" ||
        run.status === "errored" ||
        run.status === "stopped",
    );
  } catch (error) {
    log("workflows.runs.error", {
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
};

/**
 * Stage 9 v2 probes: while the run is active, capture (a) the session
 * projection's backgroundJobs (does a dynamic run surface there, and with
 * which fields?) and (b) the v4 conversation pulls the bridge could use for
 * per-step lamps (workflowRuns rows + workflowRunWorkspace nodes).
 */
const seenRunIds = new Set<string>();
const probe = async () => {
  try {
    const read = record(
      await client.request("session/read", { sessionId }, 5000),
    );
    log("probe.backgroundJobs", record(read.projection).backgroundJobs);
  } catch (error) {
    log("probe.sessionRead.error", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    const v4runs = record(
      await client.request(
        "v4/conversation/workflowRuns",
        { sessionId, limit: 10 },
        5000,
      ),
    );
    log("probe.v4.workflowRuns", v4runs);
    const rows = Array.isArray(v4runs.runs) ? v4runs.runs.map(record) : [];
    for (const row of rows) {
      const runId = text(row.runId);
      if (!runId || seenRunIds.has(runId)) continue;
      seenRunIds.add(runId);
      try {
        log(
          "probe.v4.workflowRunWorkspace",
          await client.request(
            "v4/conversation/workflowRunWorkspace",
            { sessionId, runId },
            5000,
          ),
        );
      } catch (error) {
        log("probe.v4.workflowRunWorkspace.error", {
          runId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      try {
        log(
          "probe.v4.workflowRunEvents",
          await client.request(
            "v4/conversation/workflowRunEvents",
            { sessionId, runId, limit: 80 },
            5000,
          ),
        );
      } catch (error) {
        log("probe.v4.workflowRunEvents.error", {
          runId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    log("probe.v4.workflowRuns.error", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

let terminalRun: Record<string, unknown> | undefined;
const deadline = Date.now() + 240_000;
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 3000));
  if (!terminal || workflowToolCalls === 0) {
    if (terminal) break; // turn ended without a workflow call — stop early.
    continue;
  }
  await probe();
  terminalRun = await runTerminal();
  if (terminalRun) break;
}
await probe();
await runTerminal();
if (terminal) log("turn.terminal", terminal);
log("poc.summary", {
  toolCatalogWorkflowTools: toolCatalog.filter((name) =>
    /Workflow|workflow/.test(name),
  ),
  skillToolCalls,
  workflowToolCalls,
  modelRequests,
  sawApproval,
  sawRunNotification,
  eventTypes: Object.fromEntries(eventTypes),
  displayPayloadCount: displayPayloads.length,
  terminalRunStatus: terminalRun?.status ?? null,
});
await client.close();
// The listening model server pins the Node event loop; without this the
// finished POC process lingers forever and the surrounding background task
// never completes.
modelServer.closeAllConnections?.();
await new Promise<void>((resolve) => modelServer.close(() => resolve()));
if (!terminalRun)
  throw new Error(
    `POC did not reach a terminal workflow run (turn: ${JSON.stringify(terminal?.resultType ?? "none")}).`,
  );
