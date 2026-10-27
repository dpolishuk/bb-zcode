import { expect, it } from "vitest";
import {
  threadDeltaSchema,
  type ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";
import { Timeline } from "../src/timeline.js";
import { record } from "../src/protocol.js";

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

it("maps CreateWorkflow onto the plugin's workflow-graph extension row", () => {
  const deltas: ThreadDelta[] = [];
  const timeline = new Timeline((d) => deltas.push(...d), "/w");
  timeline.event("tool.updated", {
    kind: "scheduled",
    toolCallId: "wf-1",
    toolName: "CreateWorkflow",
    input: {
      script:
        'const meta = {\n  name: "poc-two-phase",\n  description: "POC",\n};\nphase("first");',
    },
  });
  const open = deltas.find((d) => d.kind === "item.open")!;
  // The graph payload from the POC display contract, trimmed to the fields
  // the renderer reads.
  timeline.event("tool.updated", {
    kind: "result",
    toolCallId: "wf-1",
    duration: 50,
    result: {
      success: true,
      content:
        "The workflow script compiled cleanly and the run started in the background with ID: dwfrun-f1936cc6-91e9. It is still running. The script is saved at .zcode/workflow-drafts/first.dwf.ts; to revise it later, edit that file and pass `path` to AmendWorkflow.",
      display: {
        kind: "create_workflow",
        ok: true,
        errorCount: 0,
        diagnostics: [],
        causalityGraph: {
          steps: [
            {
              id: "ask#1",
              kind: "ask",
              label: "one",
              lane: "actor#1",
              phase: "phase#1",
            },
            {
              id: "ask#2",
              kind: "ask",
              label: "two",
              lane: "actor#2",
              phase: "phase#2",
            },
          ],
          lanes: [
            { id: "actor#1", name: "one" },
            { id: "actor#2", name: "two" },
          ],
          participants: [
            {
              id: "phase#1:actor#1",
              phase: "phase#1",
              lane: "actor#1",
              steps: ["ask#1"],
            },
            {
              id: "phase#2:actor#2",
              phase: "phase#2",
              lane: "actor#2",
              steps: ["ask#2"],
            },
          ],
          handoffs: [],
          phases: [
            { id: "phase#1", name: "first" },
            { id: "phase#2", name: "second" },
          ],
          phaseEdges: [{ from: "phase#1", to: "phase#2" }],
          exits: ["phase#2"],
        },
      },
    },
  });
  expect(open.item).toEqual({
    type: "extension",
    kind: "zcode/workflow-graph",
    payload: { v: 1, state: "running", title: "poc-two-phase" },
  });
  expect(open.presentation).toMatchObject({
    label: { pending: "Running workflow" },
    detail: "poc-two-phase",
  });
  const close = deltas.find((d) => d.kind === "item.close")!;
  expect(close.status).toBe("completed");
  expect(close.item).toMatchObject({
    type: "extension",
    kind: "zcode/workflow-graph",
  });
  const payload = (close.item as { payload: Record<string, unknown> }).payload;
  expect(payload.state).toBe("done");
  expect(payload.ok).toBe(true);
  expect(payload.runId).toBe("dwfrun-f1936cc6-91e9");
  expect(payload.scriptPath).toBe(".zcode/workflow-drafts/first.dwf.ts");
  const graph = record(payload.graph);
  expect(graph.phases).toEqual([
    { id: "phase#1", name: "first" },
    { id: "phase#2", name: "second" },
  ]);
  // No generic tool row may appear beside the extension row.
  expect(
    deltas.some(
      (d) =>
        (d.kind === "item.open" || d.kind === "item.close") &&
        (d.item as { type?: string })?.type === "tool",
    ),
  ).toBe(false);
  for (const d of deltas)
    expect(threadDeltaSchema.safeParse(d).success).toBe(true);
});

it("keeps the workflow row honest without a graph and on errors", () => {
  const deltas: ThreadDelta[] = [];
  const timeline = new Timeline((d) => deltas.push(...d), "/w");
  timeline.event("tool.updated", {
    kind: "scheduled",
    toolCallId: "wf-2",
    toolName: "CreateWorkflow",
    input: { saved: { name: "nightly" } },
  });
  timeline.event("tool.updated", {
    kind: "error",
    toolCallId: "wf-2",
    error: { message: "The workflow script has errors" },
  });
  const close = deltas.find((d) => d.kind === "item.close")!;
  expect(close.status).toBe("failed");
  const payload = (close.item as { payload: Record<string, unknown> }).payload;
  expect(payload.state).toBe("failed");
  expect(payload.graph).toBeUndefined();
  expect(payload.error).toContain("workflow script has errors");
  for (const d of deltas)
    expect(threadDeltaSchema.safeParse(d).success).toBe(true);
});
