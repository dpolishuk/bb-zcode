// Synthetic protocol peer, not evidence of a real model run.
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
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
  projection: { turnCount: sessions.get(id)?.turn ?? 0, backgroundJobs: [] },
});
function event(sessionId, type, payload) {
  const session = sessions.get(sessionId);
  if (type === "turn.completed") {
    session.rows.push({
      kind: "assistantText",
      rowId: session.turn * 4,
      entityId: `message-${session.turn}`,
      turnId: `native-turn-${session.turn}`,
      state: "complete",
      actions: { canFork: true },
      text: payload.response,
    });
    writeFileSync(
      join(process.cwd(), sessionId + ".json"),
      JSON.stringify(session),
    );
  }
  send({
    method: "session/event",
    params: {
      sessionId,
      type,
      payload,
      eventSeq: ++session.seq,
      turnId: `native-turn-${session.turn}`,
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
  sessions.get(sessionId).turn++;
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
    const stored = existsSync(file)
      ? JSON.parse(readFileSync(file, "utf8"))
      : {};
    sessions.set(id, { seq: 0, turn: 0, rows: [], ...stored });
    writeFileSync(file, JSON.stringify(sessions.get(id)));
    send({ id: m.id, result: snapshot(id) });
  } else if (m.method === "session/read")
    send({ id: m.id, result: snapshot(p.sessionId) });
  else if (m.method === "v4/conversation/rowsRange")
    send({
      id: m.id,
      result: {
        rows: sessions.get(p.sessionId).rows,
        atSeq: 1,
        atRevision: 1,
        atLogEpoch: "fixture",
        hasMore: false,
      },
    });
  else if (m.method === "v4/command" && p.type === "forkAssistant") {
    const source = sessions.get(p.sessionId),
      child = `sess_${randomUUID()}`;
    const rows = source.rows.filter((r) => r.rowId <= p.payload.target.rowId);
    const state = { seq: 0, turn: rows.length, rows };
    sessions.set(child, state);
    writeFileSync(join(process.cwd(), child + ".json"), JSON.stringify(state));
    send({
      id: m.id,
      result: {
        commandId: p.commandId,
        status: "accepted",
        revisionAtDecision: 1,
        result: { type: "forkAssistant", sessionId: child },
      },
    });
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
