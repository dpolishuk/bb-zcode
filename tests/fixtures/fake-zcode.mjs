// Synthetic protocol peer, not evidence of a real model run.
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
const pending = new Map();
const sessions = new Map();
const input = createInterface({ input: process.stdin });
const snapshot = (id) => ({
  session: { sessionId: id },
  settings: {
    model: {
      current: { providerId: "test", modelId: "model" },
      available: [
        {
          ref: { providerId: "test", modelId: "model" },
          label: "Fixture model",
        },
      ],
    },
  },
  projection: { turnCount: 0 },
});
function event(sessionId, type, payload) {
  const session = sessions.get(sessionId);
  send({
    method: "session/event",
    params: {
      sessionId,
      type,
      payload,
      eventSeq: ++session.seq,
      turnId: "native-turn",
    },
  });
}
function host(method, params) {
  const id = randomUUID();
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ id, method, params });
  });
}
async function run(p) {
  const sessionId = p.sessionId;
  event(sessionId, "turn.started", { inputId: p.inputId });
  if (p.content === "hang") return;
  if (p.content === "crash") {
    process.exitCode = 2;
    input.close();
    process.stdin.destroy();
    return;
  }
  if (p.content === "permission") {
    event(sessionId, "tool.updated", {
      kind: "scheduled",
      toolCallId: "call-1",
      toolName: "Bash",
      input: { command: "pwd" },
    });
    const response = await host("interaction/requestPermission", {
      sessionId,
      toolCallId: "call-1",
      toolName: "Bash",
      input: { command: "pwd" },
      reason: "Fixture approval",
      options: [
        { response: { decision: "allow" } },
        { response: { decision: "deny" } },
      ],
    });
    event(sessionId, "tool.updated", {
      kind: "result",
      toolCallId: "call-1",
      result: { output: response.decision },
      duration: 1,
    });
    event(sessionId, "turn.completed", {
      response: response.decision,
      resultType: "success",
    });
    return;
  }
  if (p.content === "question") {
    const answer = await host("interaction/requestUserInput", {
      sessionId,
      questions: [
        {
          question: "Which one?",
          header: "Choice",
          options: [{ value: "a", label: "A" }],
        },
      ],
    });
    event(sessionId, "turn.completed", {
      response: JSON.stringify(answer),
      resultType: "success",
    });
    return;
  }
  if (p.content !== "/noop") {
    event(sessionId, "model.streaming", {
      kind: "reasoning_delta",
      assistantMessageId: "m1",
      partId: "r1",
      delta: "Considering",
    });
    event(sessionId, "model.streaming", {
      kind: "reasoning_end",
      assistantMessageId: "m1",
      partId: "r1",
    });
    event(sessionId, "tool.updated", {
      kind: "scheduled",
      toolCallId: "read-1",
      toolName: "Read",
      input: { file_path: "README.md" },
    });
    event(sessionId, "tool.updated", {
      kind: "result",
      toolCallId: "read-1",
      result: { output: "fixture content" },
      duration: 2,
    });
    event(sessionId, "model.streaming", {
      kind: "text_delta",
      assistantMessageId: "m1",
      partId: "t1",
      delta: "Hello ",
    });
    event(sessionId, "model.streaming", {
      kind: "text_delta",
      assistantMessageId: "m1",
      partId: "t1",
      delta: "world",
    });
    event(sessionId, "model.streaming", {
      kind: "text_end",
      assistantMessageId: "m1",
      partId: "t1",
    });
  }
  event(sessionId, "turn.completed", {
    response: p.content === "/noop" ? "" : "Hello world",
    resultType: "success",
  });
}
input.on("line", async (line) => {
  const m = JSON.parse(line);
  if (!m.method) {
    pending.get(m.id)?.(m.result);
    pending.delete(m.id);
    return;
  }
  const p = m.params;
  if (m.method === "session/create" || m.method === "session/resume") {
    await host("session/requestRuntimePreferences", {
      sessionId: p.sessionId ?? "creating",
      scope: "runtime-materialization",
    });
    const id = p.sessionId ?? `sess_${randomUUID()}`;
    const file = join(process.cwd(), id + ".json");
    if (m.method === "session/resume" && !existsSync(file)) {
      send({ id: m.id, error: { code: -32004, message: "Missing session" } });
      return;
    }
    writeFileSync(file, "{}");
    sessions.set(id, { seq: 0 });
    send({ id: m.id, result: snapshot(id) });
  } else if (m.method === "session/subscribe")
    send({
      id: m.id,
      result: { sessionId: p.sessionId, events: [], eventSeq: 0 },
    });
  else if (m.method === "session/send") {
    if (p.content === "reject") {
      send({
        id: m.id,
        error: { code: -32010, message: "Fixture rejected prompt" },
      });
      return;
    }
    if (p.content === "early") {
      await run(p);
      send({ id: m.id, result: { accepted: true } });
    } else {
      send({ id: m.id, result: { accepted: true } });
      setTimeout(() => {
        void run(p);
      }, 5);
    }
  } else if (m.method === "session/stop") {
    send({ id: m.id, result: {} });
  } else if (m.method === "session/setMode") send({ id: m.id, result: {} });
  else send({ id: m.id, error: { code: -32601, message: "Unknown method" } });
});
input.on("close", () => {
  process.stdin.destroy();
});
