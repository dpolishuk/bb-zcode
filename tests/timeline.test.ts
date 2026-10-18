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
