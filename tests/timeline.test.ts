import { expect, it } from "vitest";
import {
  threadDeltaSchema,
  type ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";
import { Timeline } from "../src/timeline.js";

it("retains nested tool attribution and streams bounded progress", () => {
  const deltas: ThreadDelta[] = [];
  const timeline = new Timeline((d) => deltas.push(...d));
  timeline.event("tool.updated", {
    kind: "scheduled",
    toolCallId: "child-tool",
    parentToolCallId: "parent-agent",
    source: "subagent",
    agentType: "reviewer",
    toolName: "Bash",
    input: { command: "echo progress" },
  });
  timeline.event("tool.updated", {
    kind: "progress",
    toolCallId: "child-tool",
    stdoutTail: "progress",
  });
  timeline.event("tool.updated", {
    kind: "result",
    toolCallId: "child-tool",
    result: { success: true },
    duration: 2,
  });
  expect(deltas[0]).toMatchObject({
    kind: "item.open",
    key: { providerItemId: "child-tool", parentRef: "parent-agent" },
  });
  expect(deltas).toContainEqual(
    expect.objectContaining({
      kind: "command.outputSnapshot",
      text: "progress",
    }),
  );
  expect(deltas.at(-1)).toMatchObject({
    kind: "item.close",
    key: { parentRef: "parent-agent" },
  });
  for (const d of deltas)
    expect(threadDeltaSchema.safeParse(d).success).toBe(true);
});

it("retains final command stdout and stderr without requiring progress events", () => {
  const deltas: ThreadDelta[] = [];
  const timeline = new Timeline((d) => deltas.push(...d), "/workspace");
  timeline.event("tool.updated", {
    kind: "scheduled",
    toolCallId: "bash",
    toolName: "Bash",
    input: { command: "echo hello" },
  });
  timeline.event("tool.updated", {
    kind: "result",
    toolCallId: "bash",
    result: { stdout: "hello", stderr: "warning", exitCode: 0 },
    duration: 2,
  });
  expect(deltas.at(-1)).toMatchObject({
    item: {
      type: "command",
      command: "echo hello",
      cwd: "/workspace",
      aggregatedOutput: "hello\nwarning",
      exitCode: 0,
    },
  });
});

it("joins native streamed tool input to scheduled events that omit arguments", () => {
  const deltas: ThreadDelta[] = [];
  const timeline = new Timeline((d) => deltas.push(...d), "/workspace");
  timeline.event("model.streaming", {
    kind: "tool_call",
    toolCallId: "bash",
    toolName: "Bash",
    input: { command: "echo hello" },
  });
  timeline.event("tool.updated", {
    kind: "scheduled",
    toolCallId: "bash",
    toolName: "Bash",
    inputOmitted: true,
    inputRef: "model_stream",
  });
  timeline.event("tool.updated", {
    kind: "result",
    toolCallId: "bash",
    result: {
      success: true,
      content: "hello",
      display: { kind: "bash_output", output: "hello", truncated: false },
    },
    duration: 2,
  });
  expect(deltas[0]).toMatchObject({
    kind: "item.open",
    item: { type: "command", command: "echo hello", cwd: "/workspace" },
  });
  expect(deltas.at(-1)).toMatchObject({
    item: { type: "command", aggregatedOutput: "hello" },
  });
});

it("keeps native command errors visible in a failed command row", () => {
  const deltas: ThreadDelta[] = [];
  const timeline = new Timeline((d) => deltas.push(...d), "/workspace");
  timeline.event("tool.updated", {
    kind: "scheduled",
    toolCallId: "bash",
    toolName: "Bash",
    input: { command: "echo hello" },
  });
  timeline.event("tool.updated", {
    kind: "error",
    toolCallId: "bash",
    error: { message: "Permission denied by fixture" },
  });
  expect(deltas.at(-1)).toMatchObject({
    kind: "item.close",
    status: "failed",
    item: { type: "command", aggregatedOutput: "Permission denied by fixture" },
  });
});

function collect() {
  const deltas: ThreadDelta[] = [];
  return { deltas, timeline: new Timeline((d) => deltas.push(...d), "/w") };
}

it("maps file edits onto rich fileChange rows", () => {
  const { deltas, timeline } = collect();
  timeline.event("tool.updated", {
    kind: "scheduled",
    toolCallId: "edit",
    toolName: "Edit",
    input: {
      file_path: "/w/src/a.ts",
      old_string: "before",
      new_string: "after",
    },
  });
  timeline.event("tool.updated", {
    kind: "result",
    toolCallId: "edit",
    result: { success: true },
    duration: 3,
  });
  expect(deltas[0]).toMatchObject({
    kind: "item.open",
    item: {
      type: "fileChange",
      changes: [
        {
          kind: "update",
          path: "/w/src/a.ts",
          oldText: "before",
          newText: "after",
        },
      ],
    },
  });
  expect(deltas.at(-1)).toMatchObject({
    kind: "item.close",
    status: "completed",
    item: { type: "fileChange" },
  });
  for (const d of deltas)
    expect(threadDeltaSchema.safeParse(d).success).toBe(true);
});

it("maps file writes, reads, and searches onto rich rows", () => {
  const { deltas, timeline } = collect();
  const tools: Array<[string, unknown, Record<string, unknown>]> = [
    [
      "Write",
      { file_path: "/w/new.ts", content: "body" },
      { type: "fileChange" },
    ],
    [
      "Read",
      { file_path: "/w/new.ts" },
      { type: "fileRead", path: "/w/new.ts" },
    ],
    [
      "Grep",
      { pattern: "TODO", path: "/w/src" },
      { type: "search", query: "TODO", mode: "content", path: "/w/src" },
    ],
    [
      "Glob",
      { pattern: "*.ts" },
      { type: "search", query: "*.ts", mode: "path" },
    ],
    [
      "WebSearch",
      { query: "bb plugin" },
      { type: "webSearch", queries: ["bb plugin"] },
    ],
    [
      "WebFetch",
      { url: "https://example.com" },
      { type: "webFetch", url: "https://example.com" },
    ],
  ];
  for (const [i, [name, input, expected]] of tools.entries()) {
    timeline.event("tool.updated", {
      kind: "scheduled",
      toolCallId: `t${i}`,
      toolName: name,
      input,
    });
    timeline.event("tool.updated", {
      kind: "result",
      toolCallId: `t${i}`,
      result: { success: true },
    });
  }
  const opens = deltas.filter((d) => d.kind === "item.open");
  for (const [, , expected] of tools)
    expect(opens).toContainEqual(
      expect.objectContaining({
        kind: "item.open",
        item: expect.objectContaining(expected),
      }),
    );
  for (const d of deltas)
    expect(threadDeltaSchema.safeParse(d).success).toBe(true);
});

it("maps TodoWrite onto plan steps with native status translation", () => {
  const { deltas, timeline } = collect();
  timeline.event("tool.updated", {
    kind: "scheduled",
    toolCallId: "todos",
    toolName: "TodoWrite",
    input: {
      todos: [
        { content: "First", status: "completed" },
        { content: "Second", status: "in_progress" },
        { content: "Third", status: "pending" },
      ],
    },
  });
  timeline.event("tool.updated", {
    kind: "result",
    toolCallId: "todos",
    result: { success: true },
  });
  expect(deltas[0]).toMatchObject({
    item: {
      type: "planSteps",
      steps: [
        { step: "First", status: "completed" },
        { step: "Second", status: "active" },
        { step: "Third", status: "pending" },
      ],
    },
  });
  for (const d of deltas)
    expect(threadDeltaSchema.safeParse(d).success).toBe(true);
});

it("maps Task delegations with a summary from the native result", () => {
  const { deltas, timeline } = collect();
  timeline.event("tool.updated", {
    kind: "scheduled",
    toolCallId: "agent-run",
    toolName: "Task",
    input: { description: "Review changes", subagent_type: "reviewer" },
  });
  timeline.event("tool.updated", {
    kind: "result",
    toolCallId: "agent-run",
    result: { success: true, content: "Reviewed 3 files." },
  });
  expect(deltas[0]).toMatchObject({
    item: {
      type: "delegation",
      label: "Review changes",
      childRef: "agent-run",
    },
  });
  expect(deltas.at(-1)).toMatchObject({
    item: { type: "delegation", summary: "Reviewed 3 files." },
  });
  for (const d of deltas)
    expect(threadDeltaSchema.safeParse(d).success).toBe(true);
});

it("falls back to a generic tool row with a visible error when a mapped tool fails", () => {
  const { deltas, timeline } = collect();
  timeline.event("tool.updated", {
    kind: "scheduled",
    toolCallId: "edit",
    toolName: "Edit",
    input: { file_path: "/w/a.ts", old_string: "x", new_string: "y" },
  });
  timeline.event("tool.updated", {
    kind: "error",
    toolCallId: "edit",
    error: { message: "String not found" },
  });
  expect(deltas.at(-1)).toMatchObject({
    kind: "item.close",
    status: "failed",
    item: { type: "tool", tool: "Edit", error: "String not found" },
  });
});

it("keeps the generic tool row for unknown tools and partial inputs", () => {
  const { deltas, timeline } = collect();
  timeline.event("tool.updated", {
    kind: "scheduled",
    toolCallId: "odd",
    toolName: "NotebookEdit",
    input: { notebook_path: "/w/nb" },
  });
  timeline.event("tool.updated", {
    kind: "scheduled",
    toolCallId: "readless",
    toolName: "Read",
    input: {},
  });
  const opens = deltas.filter((d) => d.kind === "item.open");
  expect(opens).toContainEqual(
    expect.objectContaining({
      item: expect.objectContaining({ type: "tool", tool: "NotebookEdit" }),
    }),
  );
  expect(opens).toContainEqual(
    expect.objectContaining({
      item: expect.objectContaining({ type: "tool", tool: "Read" }),
    }),
  );
  for (const d of deltas)
    expect(threadDeltaSchema.safeParse(d).success).toBe(true);
});
