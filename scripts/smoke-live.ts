import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ZCodeClient, ProtocolError } from "../src/client.js";
import { resolveLaunch, workspaceRef } from "../src/launch.js";
import { RUNTIME_PREFERENCES, record } from "../src/protocol.js";
import { createBridge } from "../src/bridge.js";
import { smokeCodingPlan } from "./smoke-coding-plan.js";

// Opt-in real CLI test against a deterministic loopback model, with no credentials.
const root = mkdtempSync(join(tmpdir(), "bb-zcode-live-"));
const cwd = join(root, "workspace");
mkdirSync(cwd);
let modelRequests = 0;
let imageRequests = 0;
let bbToolCalls = 0;
let skillReads = 0;
let bashResults = 0;
let childQuestions = 0;
let customAgentRequests = 0;
let installedToolResults = 0;
let installedSkillReads = 0;
let automaticBackgroundModelRequests = 0;
let installedForkContextVerified = false;
let installedRewindContextVerified = false;
const skillRoot = join(root, "bb-skills");
const skillPath = join(skillRoot, "fixture-skill", "SKILL.md");
mkdirSync(join(skillRoot, "fixture-skill", "references"), { recursive: true });
writeFileSync(
  skillPath,
  "# BB_FIXTURE_SKILL_CONTENT\nRead references/check.md\n",
);
writeFileSync(
  join(skillRoot, "fixture-skill", "references", "check.md"),
  "BB_FIXTURE_SKILL_REFERENCE\n",
);
const receivedEfforts: string[] = [];
const modelServer = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  // Keep only the selected effort, never model input or credentials.
  const body = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  const tools = Array.isArray(body.tools) ? body.tools.map(record) : [];
  const fixtureTool = tools.find((t) =>
    String(t.name).includes("fixture_echo"),
  );
  const lastMessage = JSON.stringify(
    Array.isArray(body.messages) ? body.messages.at(-1) : {},
  );
  const allModelText = (Array.isArray(body.messages) ? body.messages : [])
    .flatMap((m) => {
      const content = record(m).content;
      return Array.isArray(content)
        ? content.map((c) => String(record(c).text ?? ""))
        : [String(content ?? "")];
    })
    .join("\n");
  if (
    lastMessage.includes("Continue this checkpoint fork with a short greeting.")
  ) {
    if (
      !allModelText.includes("BB_FIXTURE_DELAY") ||
      allModelText.includes("BB_FIXTURE_INSTALLED_SKILL")
    )
      throw new Error(
        "Installed fork inference retained the wrong history window.",
      );
    installedForkContextVerified = true;
  }
  if (lastMessage.includes("Replacement greeting after native bb rewind.")) {
    if (
      !allModelText.includes("BB_FIXTURE_INSTALLED_SKILL") ||
      allModelText.includes("BB_FIXTURE_INSTALLED_AGENT")
    )
      throw new Error("Installed rewind inference retained the replaced turn.");
    installedRewindContextVerified = true;
  }
  if (
    lastMessage.includes('"tool_result"') &&
    lastMessage.includes("BB_INSTALLED_TOOL_RESULT")
  )
    installedToolResults++;
  if (
    lastMessage.includes('"tool_result"') &&
    lastMessage.includes("BB_INSTALLED_SKILL_CONTENT")
  )
    installedSkillReads++;
  if (
    lastMessage.includes('"tool_result"') &&
    lastMessage.includes("BB_FIXTURE_BASH_RESULT")
  )
    bashResults++;
  const callMcp =
    !!fixtureTool &&
    lastMessage.includes("BB_FIXTURE_MCP_TOOL") &&
    !lastMessage.includes('"tool_result"');
  if (JSON.stringify(body.system).includes("BB_FIXTURE_CUSTOM_AGENT"))
    customAgentRequests++;
  let toolCall: { name: string; input: unknown } | undefined = callMcp
    ? { name: String(fixtureTool!.name), input: { text: "hello" } }
    : undefined;
  if (!lastMessage.includes('"tool_result"')) {
    if (lastMessage.includes("BB_FIXTURE_BB_TOOL")) {
      const tool = tools.find((t) =>
        String(t.description).includes("fixture.echo"),
      );
      if (!tool)
        throw new Error("Injected bb tool missing from model tool catalog.");
      toolCall = { name: String(tool.name), input: { text: "bb echo" } };
    } else if (lastMessage.includes("BB_FIXTURE_SKILL_READ")) {
      if (!lastMessage.includes(skillPath))
        throw new Error("bb skill catalog did not reach the model.");
      toolCall = { name: "Read", input: { file_path: skillPath } };
    } else if (lastMessage.includes("BB_FIXTURE_INSTALLED_SKILL")) {
      const match = allModelText.match(
        /"path":"([^"\n]*fixture-installed-skill\/SKILL\.md)"/,
      );
      if (!match)
        throw new Error("Installed bb skill catalog did not reach the model.");
      toolCall = { name: "Read", input: { file_path: match[1] } };
    } else if (
      lastMessage.includes("BB_FIXTURE_WRITE_ONE") ||
      lastMessage.includes("BB_FIXTURE_WRITE_TWO")
    ) {
      toolCall = {
        name: "Write",
        input: {
          file_path: join(cwd, "rewind-fixture.txt"),
          content: lastMessage.includes("BB_FIXTURE_WRITE_ONE")
            ? "before rewind\n"
            : "after rewind\n",
        },
      };
    } else if (lastMessage.includes("BB_FIXTURE_BACKGROUND")) {
      toolCall = {
        name: "Bash",
        input: {
          command:
            "printf BB_BACKGROUND_READY; sleep 15; printf BB_BACKGROUND_DONE",
          run_in_background: true,
        },
      };
    } else if (lastMessage.includes("BB_FIXTURE_BASH")) {
      toolCall = {
        name: "Bash",
        input: { command: "printf BB_FIXTURE_BASH_RESULT" },
      };
    } else if (lastMessage.includes("BB_FIXTURE_INSTALLED_AGENT")) {
      toolCall = {
        name: "Agent",
        input: {
          description: "Installed fixture reviewer",
          subagent_type: "fixture-reviewer",
          prompt: "Say a short greeting.",
        },
      };
    } else if (lastMessage.includes("BB_FIXTURE_AGENT")) {
      toolCall = {
        name: "Agent",
        input: {
          description: "Fixture reviewer",
          subagent_type: "fixture-reviewer",
          prompt: "BB_FIXTURE_CHILD Ask the fixture question.",
        },
      };
    } else if (lastMessage.includes("BB_FIXTURE_CHILD")) {
      toolCall = {
        name: "AskUserQuestion",
        input: {
          questions: [
            {
              question: "Fixture choice?",
              header: "Fixture",
              options: [
                { label: "Proceed", description: "Continue fixture" },
                { label: "Stop", description: "End fixture" },
              ],
              multiSelect: false,
            },
          ],
        },
      };
    }
  }
  if (
    lastMessage.includes("BB_FIXTURE_SKILL_CONTENT") &&
    lastMessage.includes('"tool_result"')
  )
    skillReads++;
  if (JSON.stringify(body.messages).includes('"type":"image"')) imageRequests++;
  const effort = record(body.output_config).effort;
  if (typeof effort === "string") receivedEfforts.push(effort);
  modelRequests++;
  await new Promise((resolve) =>
    setTimeout(resolve, lastMessage.includes("BB_FIXTURE_DELAY") ? 1500 : 100),
  );
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
  if (toolCall) {
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
    event("message_stop", { type: "message_stop" });
    response.end();
    return;
  }
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
  const dynamicTools = [
    {
      name: "fixture.echo",
      description: "bb fixture echo",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      presentation: {
        label: { pending: "Echoing", completed: "Echo" },
        icon: { glyph: "Terminal" },
      },
    },
  ];
  const bridge = createBridge({
    env,
    write: (message) => {
      messages.push(message);
      if (message.method === "item/tool/call") {
        bbToolCalls++;
        if (record(message.params).tool !== "fixture.echo")
          throw new Error("Wrong bb fixture tool.");
        bridge.handleLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              success: true,
              contentItems: [{ type: "inputText", text: "bb echo" }],
            },
          }),
        );
      } else if (message.method === "interaction/request") {
        const payload = record(record(message.params).payload);
        if (payload.kind === "user_question") {
          childQuestions++;
          bridge.handleLine(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                kind: "user_answer",
                answers: { q0: { selected: ["Proceed"], freeText: null } },
              },
            }),
          );
        } else if (payload.kind === "approval") {
          bridge.handleLine(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: { decision: "allow_once" },
            }),
          );
        }
      }
    },
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
    reasoningLevel: "high",
    providerOptions: {
      bbToolsEnabled: true,
      subagents: JSON.stringify({
        kind: "ready",
        profiles: [
          {
            name: "fixture-reviewer",
            description: "Fixture reviewer",
            source: "user",
            systemPrompt:
              "BB_FIXTURE_CUSTOM_AGENT. Follow the user's fixture prompt.",
            tools: ["Read", "AskUserQuestion"],
            maxTurns: 3,
          },
        ],
        builtInModelSelectionOverrides: {},
        pluginAgentModelSelectionOverrides: {},
      }),
      mcpServers: JSON.stringify([
        {
          name: "fixture",
          command: process.execPath,
          args: [resolve("tests/fixtures/mcp-server.mjs")],
          env: [
            {
              name: "BB_MCP_FIXTURE_LOG",
              value: join(root, "mcp-methods.jsonl"),
            },
          ],
        },
      ]),
    },
  };
  try {
    await rpc("skills/configure", {
      roots: [
        {
          id: "fixture",
          path: skillRoot,
          skills: [{ name: "fixture-skill", description: "Fixture skill" }],
        },
      ],
    });
    const catalog = await rpc("model/list", { cwd });
    const discovered = (catalog.models as Array<Record<string, unknown>>).find(
      (entry) => entry.model === "bb-smoke/fixture",
    );
    if (
      JSON.stringify(discovered?.supportedReasoningEfforts) !==
      JSON.stringify(
        ["disabled", "low", "medium", "high"].map((level) => ({
          reasoningEffort: level,
          label: level,
          description: "",
        })),
      )
    )
      throw new Error("Bridge did not expose every native reasoning effort.");
    const start = await rpc("thread/start", {
      threadId: "live-smoke",
      cwd,
      options,
      instructionMode: "append",
      dynamicTools,
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
    if (receivedEfforts.at(-1) !== "high")
      throw new Error("Selected high effort did not reach the model API.");
    if (
      !deltas().some((d) => d.kind === "usage") ||
      !deltas().some((d) => d.kind === "contextWindow")
    )
      throw new Error(
        "Native token usage or context was not projected into bb.",
      );
    const image = join(cwd, "fixture.png"),
      note = join(cwd, "fixture.txt");
    writeFileSync(
      image,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC",
        "base64",
      ),
    );
    writeFileSync(note, "Synthetic attachment note.");
    await rpc("turn/start", {
      threadId: "live-smoke",
      providerThreadId: start.providerThreadId,
      options,
      clientRequestId: "creq_abcdefghjm",
      input: [
        {
          type: "text",
          text: "Inspect the attached image and note. Do not call tools.",
          mentions: [],
        },
        { type: "localImage", path: image },
        { type: "localFile", path: note },
      ],
    });
    // Direct bridge smoke bypasses bb's assembler and its expected-turn check.
    const queuedTurnId = "assembler-owned-turn";
    for (const [suffix, prompt] of [
      ["abcdefghjn", "First queued greeting."],
      ["abcdefghjp", "Second queued greeting."],
    ])
      await rpc("turn/steer", {
        threadId: "live-smoke",
        providerThreadId: start.providerThreadId,
        options,
        expectedTurnId: queuedTurnId,
        clientRequestId: `creq_${suffix}`,
        input: [{ type: "text", text: prompt, mentions: [] }],
      });
    await waitFor(
      () => deltas().filter((d) => d.kind === "turn.boundary").length === 4,
    );
    if (
      deltas()
        .filter((d) => d.kind === "turn.boundary")
        .some((d) => d.status !== "completed") ||
      imageRequests === 0
    )
      throw new Error(
        `Native attachment or queued-follow-up turn failed: ${JSON.stringify({
          imageRequests,
          modelRequests,
          automaticBackgroundModelRequests,
          statuses: deltas()
            .filter((d) => d.kind === "turn.boundary")
            .map((d) => d.status),
          diagnostics: deltas()
            .filter((d) => d.kind === "item.textClose")
            .map((d) => String(d.text ?? "").slice(0, 500)),
        })}`,
      );
    await rpc("turn/start", {
      threadId: "live-smoke",
      providerThreadId: start.providerThreadId,
      options,
      clientRequestId: "creq_abcdefghjq",
      input: [{ type: "text", text: "/compact", mentions: [] }],
    });
    await waitFor(
      () => deltas().filter((d) => d.kind === "turn.boundary").length === 5,
    );
    if (
      deltas()
        .filter((d) => d.kind === "turn.boundary")
        .at(-1)?.status !== "completed"
    )
      throw new Error("Native manual compaction did not complete.");
    await rpc("turn/start", {
      threadId: "live-smoke",
      providerThreadId: start.providerThreadId,
      options,
      clientRequestId: "creq_abcdefghjr",
      input: [
        {
          type: "text",
          text: "BB_FIXTURE_MCP_TOOL Call fixture_echo with text hello.",
          mentions: [],
        },
      ],
    });
    await waitFor(
      () => deltas().filter((d) => d.kind === "turn.boundary").length === 6,
    );
    const methods = readFileSync(join(root, "mcp-methods.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => record(JSON.parse(line)));
    if (!methods.some((m) => m.method === "tools/call"))
      throw new Error(
        "The native runtime did not execute the configured MCP tool.",
      );
    for (const [index, prompt] of [
      "BB_FIXTURE_BB_TOOL Call the bb tool.",
      "BB_FIXTURE_AGENT Delegate to fixture-reviewer.",
      "BB_FIXTURE_BASH Run the deterministic echo command.",
    ].entries()) {
      await rpc("turn/start", {
        threadId: "live-smoke",
        providerThreadId: start.providerThreadId,
        options,
        clientRequestId: `creq_abcdefghk${index + 2}`,
        input: [{ type: "text", text: prompt, mentions: [] }],
      });
      await waitFor(
        () =>
          deltas().filter((d) => d.kind === "turn.boundary").length ===
          7 + index,
      );
      if (
        deltas()
          .filter((d) => d.kind === "turn.boundary")
          .at(-1)?.status !== "completed"
      )
        throw new Error("Extension fixture turn failed.");
    }
    if (
      !bashResults ||
      !deltas().some(
        (d) =>
          d.kind === "item.close" &&
          record(d.item).type === "command" &&
          String(record(d.item).aggregatedOutput).includes(
            "BB_FIXTURE_BASH_RESULT",
          ),
      )
    )
      throw new Error(
        "Native command output was not retained in bb command rows.",
      );
    if (bbToolCalls !== 1 || !childQuestions || !customAgentRequests)
      throw new Error(
        `Extension fixture incomplete: ${JSON.stringify({ bbToolCalls, childQuestions, customAgentRequests })}`,
      );
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
      dynamicTools,
    });
    if (resumedBridge.providerThreadId !== start.providerThreadId)
      throw new Error("Bridge resume changed identity.");
    await rpc("turn/start", {
      threadId: "live-smoke",
      providerThreadId: start.providerThreadId,
      options,
      clientRequestId: "creq_abcdefghk9",
      input: [
        {
          type: "text",
          text: "BB_FIXTURE_SKILL_READ Read the bb fixture skill.",
          mentions: [],
        },
      ],
    });
    await waitFor(
      () => deltas().filter((d) => d.kind === "turn.boundary").length === 10,
    );
    if (!skillReads)
      throw new Error(
        "Native Read did not return the injected skill contents.",
      );
    const parentOnly = () =>
      messages
        .filter(
          (m) =>
            m.method === "thread/delta" &&
            record(m.params).threadId === "live-smoke",
        )
        .flatMap((m) => record(m.params).deltas as Record<string, unknown>[]);
    for (const [i, marker] of [
      "BB_FIXTURE_WRITE_ONE",
      "BB_FIXTURE_WRITE_TWO",
    ].entries()) {
      const before = parentOnly().filter(
        (d) => d.kind === "turn.boundary",
      ).length;
      await rpc("turn/start", {
        threadId: "live-smoke",
        providerThreadId: start.providerThreadId,
        options,
        clientRequestId: `creq_abcdefghp${i + 2}`,
        input: [{ type: "text", text: marker, mentions: [] }],
      });
      await waitFor(
        () =>
          parentOnly().filter((d) => d.kind === "turn.boundary").length >
          before,
      );
    }
    if (
      readFileSync(join(cwd, "rewind-fixture.txt"), "utf8") !== "after rewind\n"
    )
      throw new Error("Native file fixture was not written.");
    await rpc("turn/start", {
      threadId: "live-smoke",
      providerThreadId: start.providerThreadId,
      options,
      clientRequestId: "creq_abcdefghp4",
      input: [{ type: "text", text: "/zcode-file-preview", mentions: [] }],
    });
    const previewText = parentOnly()
      .filter((d) => d.kind === "item.textClose")
      .map((d) => String(d.text))
      .join("\n");
    const previewToken = previewText.match(
      /\/zcode-file-rewind (preview-[a-f0-9-]+)/,
    )?.[1];
    if (!previewToken)
      throw new Error(
        "Native file preview did not authorize rollback: " +
          previewText.slice(-3000),
      );
    await rpc("turn/start", {
      threadId: "live-smoke",
      providerThreadId: start.providerThreadId,
      options,
      clientRequestId: "creq_abcdefghp5",
      input: [
        {
          type: "text",
          text: `/zcode-file-rewind ${previewToken}`,
          mentions: [],
        },
      ],
    });
    if (
      readFileSync(join(cwd, "rewind-fixture.txt"), "utf8") !==
      "before rewind\n"
    )
      throw new Error("Native file rewind did not restore the prior fixture.");
    // History controls operate against the actual native persisted transcript.
    const checkpoint = deltas()
      .filter((d) => d.kind === "turn.boundary" && d.providerCheckpointId)
      .at(-1)?.providerCheckpointId;
    if (!checkpoint)
      throw new Error("Native completion did not expose a stable checkpoint.");
    const fork = await rpc("thread/fork", {
      threadId: "history-child",
      sourceProviderThreadId: start.providerThreadId,
      sourceProviderCheckpointId: checkpoint,
      cwd,
      options,
      instructionMode: "append",
      dynamicTools,
    });
    if (fork.providerThreadId === start.providerThreadId)
      throw new Error("Native fork reused its parent.");
    await rpc("turn/start", {
      threadId: "history-child",
      providerThreadId: fork.providerThreadId,
      options,
      clientRequestId: "creq_abcdefghm2",
      input: [
        {
          type: "text",
          text: "Continue the fork with a greeting.",
          mentions: [],
        },
      ],
    });
    await waitFor(() =>
      messages
        .filter(
          (m) =>
            m.method === "thread/delta" &&
            record(m.params).threadId === "history-child",
        )
        .flatMap((m) => record(m.params).deltas as Record<string, unknown>[])
        .some((d) => d.kind === "turn.boundary" && d.status === "completed"),
    );
    await rpc("thread/stop", {
      threadId: "history-child",
      providerThreadId: fork.providerThreadId,
      intent: "release",
      activeTurnId: null,
    });
    const parentDeltas = () =>
      messages
        .filter(
          (m) =>
            m.method === "thread/delta" &&
            record(m.params).threadId === "live-smoke",
        )
        .flatMap((m) => record(m.params).deltas as Record<string, unknown>[]);
    let boundaries = parentDeltas().filter(
      (d) => d.kind === "turn.boundary",
    ).length;
    await rpc("turn/start", {
      threadId: "live-smoke",
      providerThreadId: start.providerThreadId,
      options,
      clientRequestId: "creq_abcdefghm3",
      input: [
        {
          type: "text",
          text: "BB_FIXTURE_BACKGROUND Start a background Bash fixture.",
          mentions: [],
        },
      ],
    });
    await waitFor(
      () =>
        parentDeltas().filter((d) => d.kind === "turn.boundary").length >
        boundaries,
    );
    await waitFor(() =>
      parentDeltas().some(
        (d) =>
          d.kind === "item.open" && record(d.item).type === "backgroundTask",
      ),
    );
    const task = parentDeltas().find(
      (d) => d.kind === "item.open" && record(d.item).type === "backgroundTask",
    )!;
    const workId = String(record(task.key).providerItemId).slice(
      "zcode-work-".length,
    );
    const beforeControls = modelRequests;
    for (const [index, prompt] of [
      `/zcode-tasks`,
      `/zcode-task-output ${workId}`,
      `/zcode-task-stop ${workId}`,
    ].entries()) {
      boundaries = parentDeltas().filter(
        (d) => d.kind === "turn.boundary",
      ).length;
      await rpc("turn/start", {
        threadId: "live-smoke",
        providerThreadId: start.providerThreadId,
        options,
        clientRequestId: `creq_abcdefghn${index + 2}`,
        input: [{ type: "text", text: prompt, mentions: [] }],
      });
      await waitFor(
        () =>
          parentDeltas().filter((d) => d.kind === "turn.boundary").length >
          boundaries,
      );
    }
    await waitFor(() =>
      parentDeltas().some(
        (d) =>
          d.kind === "item.close" &&
          record(d.key).providerItemId === `zcode-work-${workId}` &&
          d.status === "interrupted",
      ),
    );
    automaticBackgroundModelRequests = modelRequests - beforeControls;
    // ZCode may automatically notify the model when background work settles.
    await waitFor(
      () =>
        !parentDeltas().some(
          (d, i, all) =>
            d.kind === "turn.open" &&
            !all.slice(i + 1).some((next) => next.kind === "turn.boundary"),
        ),
    );
    if (
      !parentDeltas().some(
        (d) =>
          d.kind === "item.textClose" &&
          String(d.text).includes("BB_BACKGROUND_READY"),
      )
    )
      throw new Error("Native background output was not returned.");
    // A cold parent can fork the earlier checkpoint independently of later work.
    await rpc("thread/stop", {
      threadId: "live-smoke",
      providerThreadId: start.providerThreadId,
      intent: "release",
      activeTurnId: null,
    });
    const coldFork = await rpc("thread/fork", {
      threadId: "cold-fork",
      sourceProviderThreadId: start.providerThreadId,
      sourceProviderCheckpointId: checkpoint,
      cwd,
      options,
      instructionMode: "append",
      dynamicTools,
    });
    await rpc("thread/stop", {
      threadId: "cold-fork",
      providerThreadId: coldFork.providerThreadId,
      intent: "release",
      activeTurnId: null,
    });
  } finally {
    await bridge.close();
  }
  const codingPlan = await smokeCodingPlan(builtinFile, env);
  if (receivedEfforts.at(-1) !== "high")
    throw new Error("Coding Plan effort did not reach the model API.");
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
    const plugins = await cli("plugin", "list", "--json");
    // Path installs also execute immutable built artifacts. Reinstall explicitly
    // so a build in the development checkout cannot masquerade as installed proof.
    if (process.env.BB_SMOKE_PLUGIN_SOURCE) {
      if (Array.isArray(plugins) && plugins.some((p) => p.id === "zcode"))
        await cli("plugin", "remove", "zcode", "--json");
      await cli(
        "plugin",
        "install",
        process.env.BB_SMOKE_PLUGIN_SOURCE,
        "--yes",
        "--json",
      );
    }

    if (Array.isArray(plugins) && plugins.some((p) => p.id === "zcode-fixture"))
      await cli("plugin", "remove", "zcode-fixture", "--json");
    await cli(
      "plugin",
      "install",
      resolve("tests/fixtures/bb-extension-plugin"),
      "--yes",
      "--json",
    );
    await cli(
      "plugin",
      "config",
      "zcode",
      "set",
      "executable",
      wrapper,
      "--json",
    );
    await cli(
      "plugin",
      "config",
      "zcode",
      "set",
      "subagents",
      options.providerOptions.subagents,
      "--json",
    );
    await cli(
      "plugin",
      "config",
      "zcode",
      "set",
      "bbToolsEnabled",
      "true",
      "--json",
    );
    const models = await cli("provider", "models", "zcode", "--json");
    if (
      !Array.isArray(models) ||
      !models.some(
        (m) =>
          m.model === "bb-smoke/fixture" &&
          m.supportedReasoningEfforts.some(
            (level: { reasoningEffort: string }) =>
              level.reasoningEffort === "low",
          ),
      )
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
      "--reasoning-level",
      "low",
      "--environment",
      cwd,
      "--permission-mode",
      "full",
      "--prompt",
      "BB_FIXTURE_DELAY Reply with a short greeting. Do not call tools.",
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
      "turn/started",
      "--timeout",
      "30s",
      "--json",
    );
    await cli(
      "thread",
      "tell",
      threadId,
      "Reply to the queued follow-up. Do not call tools.",
      "--mode",
      "steer",
      "--json",
    );
    const completedDeadline = Date.now() + 30_000;
    let completedEvents: Array<Record<string, unknown>> = [];
    while (Date.now() < completedDeadline) {
      completedEvents = await cli("thread", "log", threadId, "--all", "--json");
      if (
        completedEvents.filter((e) => e.type === "turn/completed").length >= 2
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (completedEvents.filter((e) => e.type === "turn/completed").length !== 2)
      throw new Error(
        "Installed bb did not settle both the running turn and its queued follow-up.",
      );
    const accepted = completedEvents.filter(
      (e) => e.type === "turn/input/accepted",
    );
    if (accepted.length !== 2)
      throw new Error("Installed bb did not correlate both accepted inputs.");
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
    if (receivedEfforts.at(-1) !== "low")
      throw new Error("bb's selected low effort did not reach the model API.");
    const beforeInstalledImage = imageRequests;
    await cli(
      "thread",
      "tell",
      threadId,
      "Inspect the attached image and note. Do not call tools.",
      "--mode",
      "auto",
      "--image",
      join(cwd, "fixture.png"),
      "--file",
      join(cwd, "fixture.txt"),
      "--json",
    );
    const attachmentDeadline = Date.now() + 30_000;
    while (Date.now() < attachmentDeadline) {
      const events: Array<Record<string, unknown>> = await cli(
        "thread",
        "log",
        threadId,
        "--all",
        "--json",
      );
      if (events.filter((e) => e.type === "turn/completed").length >= 3) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (imageRequests <= beforeInstalledImage)
      throw new Error(
        "Installed bb image upload did not reach native model input.",
      );
    await cli("thread", "compact", threadId, "--json");
    await cli(
      "thread",
      "wait",
      threadId,
      "--status",
      "idle",
      "--timeout",
      "30s",
      "--json",
    );
    const context = await cli("thread", "context", threadId, "--json");
    if (!JSON.stringify(context).includes("200000"))
      throw new Error(
        "Installed bb context meter did not receive the native model window.",
      );
    const beforeInstalledAgent = customAgentRequests;
    for (const prompt of [
      "BB_FIXTURE_BB_TOOL Call the installed bb tool.",
      "BB_FIXTURE_INSTALLED_SKILL Read the installed fixture skill.",
      "BB_FIXTURE_INSTALLED_AGENT Delegate a greeting to fixture-reviewer.",
    ]) {
      const beforeEvents: Array<Record<string, unknown>> = await cli(
        "thread",
        "log",
        threadId,
        "--all",
        "--json",
      );
      const completions = beforeEvents.filter(
        (e) => e.type === "turn/completed",
      ).length;
      await cli("thread", "tell", threadId, prompt, "--mode", "auto", "--json");
      const end = Date.now() + 30_000;
      let finished = false;
      while (Date.now() < end) {
        const events: Array<Record<string, unknown>> = await cli(
          "thread",
          "log",
          threadId,
          "--all",
          "--json",
        );
        if (
          events.filter((e) => e.type === "turn/completed").length > completions
        ) {
          finished = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!finished)
        throw new Error("Installed extension turn did not settle.");
    }
    if (
      !installedToolResults ||
      !installedSkillReads ||
      customAgentRequests <= beforeInstalledAgent
    )
      throw new Error(
        `Installed extension results missing: ${JSON.stringify({ installedToolResults, installedSkillReads, customAgentRequests })}`,
      );
    const installedWait = async (id: string, previous: number) => {
      const end = Date.now() + 30_000;
      while (Date.now() < end) {
        const log: Array<Record<string, unknown>> = await cli(
          "thread",
          "log",
          id,
          "--all",
          "--json",
        );
        if (log.filter((e) => e.type === "turn/completed").length > previous)
          return log;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("Installed history/background operation did not settle.");
    };
    const commands = await cli("thread", "commands", threadId, "--json");
    if (!JSON.stringify(commands).includes("zcode-task-stop"))
      throw new Error("Installed provider commands are missing.");
    const sourceLog: Array<Record<string, unknown>> = await cli(
      "thread",
      "log",
      threadId,
      "--all",
      "--json",
    );
    const checkpointEvent = sourceLog.find((e) => e.type === "turn/completed");
    if (!checkpointEvent || typeof checkpointEvent.seq !== "number")
      throw new Error("Missing installed checkpoint event sequence.");
    const fork = await cli(
      "thread",
      "fork",
      threadId,
      "--source-seq-end",
      String(checkpointEvent.seq),
      "--prompt",
      "Continue this checkpoint fork with a short greeting.",
      "--json",
    );
    await installedWait(
      textForId(fork.id),
      sourceLog.filter(
        (e) =>
          e.type === "turn/completed" &&
          Number(e.seq) <= Number(checkpointEvent.seq),
      ).length,
    );
    const beforeEdit = sourceLog.filter(
      (e) => e.type === "turn/completed",
    ).length;
    await cli(
      "thread",
      "edit-message",
      threadId,
      "--message",
      "Replacement greeting after native bb rewind.",
      "--json",
    );
    // Rewind prunes the edited turn, then appends its replacement.
    const editEnd = Date.now() + 30_000;
    let edited = false;
    while (Date.now() < editEnd) {
      const log: Array<Record<string, unknown>> = await cli(
        "thread",
        "log",
        threadId,
        "--all",
        "--json",
      );
      if (
        log.some((e) =>
          JSON.stringify(e).includes(
            "Replacement greeting after native bb rewind.",
          ),
        ) &&
        log.filter((e) => e.type === "turn/completed").length >= beforeEdit
      ) {
        edited = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!edited) throw new Error("Installed bb edit/rewind did not complete.");
    let completed = (
      (await cli("thread", "log", threadId, "--all", "--json")) as Array<
        Record<string, unknown>
      >
    ).filter((e) => e.type === "turn/completed").length;
    await cli(
      "thread",
      "tell",
      threadId,
      "BB_FIXTURE_BACKGROUND Start native background Bash.",
      "--json",
    );
    let backgroundLog = await installedWait(threadId, completed);
    const taskEvent = backgroundLog.find(
      (e) =>
        e.type === "item/backgroundTask/progress" ||
        (e.type === "item/started" &&
          record(record(e.data).item).type === "backgroundTask"),
    );
    if (!taskEvent)
      throw new Error("Installed background card was not persisted.");
    completed = backgroundLog.filter((e) => e.type === "turn/completed").length;
    await cli("thread", "tell", threadId, "/zcode-tasks", "--json");
    backgroundLog = await installedWait(threadId, completed);
    const listing = await cli("thread", "output", threadId, "--json");
    const workId = String(listing.output).match(
      /^([^:\s]+): (?:running|pending)/m,
    )?.[1];
    if (!workId)
      throw new Error("Installed task list did not return its native task ID.");
    for (const command of [
      `/zcode-task-output ${workId}`,
      `/zcode-task-stop ${workId}`,
    ]) {
      completed = backgroundLog.filter(
        (e) => e.type === "turn/completed",
      ).length;
      await cli("thread", "tell", threadId, command, "--json");
      backgroundLog = await installedWait(threadId, completed);
    }
    const terminalEnd = Date.now() + 30_000;
    let closedTask = false;
    while (Date.now() < terminalEnd) {
      const log: Array<Record<string, unknown>> = await cli(
        "thread",
        "log",
        threadId,
        "--all",
        "--json",
      );
      const state = await cli("thread", "show", threadId, "--json");
      if (
        log.some(
          (e) =>
            e.type === "item/backgroundTask/completed" &&
            record(record(e.data).item).taskStatus === "killed",
        ) &&
        record(state.thread).status === "idle"
      ) {
        closedTask = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!closedTask)
      throw new Error(
        "Installed cancelled task did not close or native follow-up did not settle.",
      );
    if (!installedForkContextVerified || !installedRewindContextVerified)
      throw new Error("Installed history inference checks were not exercised.");
    bbThreadVerified = true;
  }
  console.log(
    JSON.stringify(
      {
        status: "RUNTIME_VERIFIED",
        checks: [
          "attachments, queued follow-ups, usage/context, manual compaction and configured MCP tool execution",
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
          "native effort catalog",
          "selected high effort reaches model API",
          "bb streamed deltas",
          "empty-session durability",
          "stable checkpoints, native fork continuation and cold checkpoint fork",
          "native background Bash list/output/cancel and automatic native follow-up",
          "native file preview and temporary-fixture rollback",
          "release",
          "cold resume",
        ],
        protocol: created.protocol,
        modelCount:
          (record(record(created.settings).model).available as unknown[])
            ?.length ?? 0,
        modelRequests,
        automaticBackgroundModelRequests,
        receivedEfforts,
        codingPlan,
        bbThreadVerified,
        installedForkContextVerified,
        installedRewindContextVerified,
        extensions: {
          bbToolCalls,
          skillReads,
          bashResults,
          childQuestions,
          customAgentRequests,
          installedToolResults,
          installedSkillReads,
        },
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
