import type {
  ThreadDelta,
  DeltaPresentation,
  DeltaItemShape,
  JsonValue,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  experimental_fileReadPresentation as sdkFileReadPresentation,
  experimental_searchPresentation as sdkSearchPresentation,
  experimental_webSearchPresentation as sdkWebSearchPresentation,
  experimental_webFetchPresentation as sdkWebFetchPresentation,
  experimental_planStepsPresentation as sdkPlanStepsPresentation,
} from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";
import { record, text } from "./protocol.js";

export const toolPresentation = (
  name: string,
  detail?: string,
): DeltaPresentation => ({
  label: { pending: `Running ${name}`, completed: name },
  icon: { glyph: "Wrench" },
  ...(detail ? { detail: detail.slice(0, 4000) } : {}),
});

/**
 * The extension item kind carrying a dynamic-workflow graph. Declared to bb in
 * `server.ts` (`extensionKinds`) and rendered by the plugin frontend's
 * `experimental_timelineRenderer` registration.
 */
export const WORKFLOW_GRAPH_EXTENSION_KIND = "zcode/workflow-graph";

const WORKFLOW_TOOL_NAMES = new Set(["CreateWorkflow"]);

/**
 * Ingest schema for the extension payload (bb validates before persisting).
 * The graph body is upstream-bounded JSON; only the envelope is load-bearing.
 */
export const workflowGraphPayloadSchema = z.looseObject({
  v: z.literal(1),
  state: z.enum(["running", "done", "failed"]),
});

const workflowPresentation = (detail?: string): DeltaPresentation => ({
  label: { pending: "Running workflow", completed: "Workflow" },
  icon: { glyph: "Workflow" },
  ...(detail ? { detail: detail.slice(0, 4000) } : {}),
});

/** Wire-safe JSON for extension payloads: drops undefined, rejects cycles. */
const json = (value: Record<string, unknown>): JsonValue =>
  JSON.parse(JSON.stringify(value)) as JsonValue;

/** Lightweight `meta` name pickup for the running row's title. */
function workflowScriptTitle(script: string): string | undefined {
  const meta = script.slice(0, 2048);
  const match = meta.match(/name:\s*["'`]([^"'`\n]{1,128})["'`]/);
  return match?.[1];
}

/**
 * Running-state payload: the renderer draws the declarative base only until
 * the graph arrives with the result.
 */
export function workflowPayloadRunning(
  input: unknown,
): Record<string, unknown> {
  const args = record(input);
  const script = text(args.script);
  const saved = record(args.saved);
  const title =
    workflowScriptTitle(script) ?? text(saved.name) ?? text(args.name);
  return {
    v: 1,
    state: "running",
    ...(title ? { title } : {}),
  };
}

/**
 * Final payload: the native `create_workflow` display payload carries the
 * full causality graph (steps/lanes/participants/handoffs/phases/edges,
 * already bounded upstream). The run id and editable script path only exist
 * in the human-readable content, so they are picked out for the renderer.
 */
export function workflowPayloadDone(
  result: unknown,
  error?: string,
): Record<string, unknown> {
  const r = record(result);
  const display = record(r.display);
  const content = text(r.content);
  const runId = content.match(/dwfrun-[a-z0-9-]+/i)?.[0];
  const scriptPath = content.match(/\.zcode\/[^\s;,]+?\.dwf\.ts/i)?.[0];
  const graph =
    display.kind === "create_workflow" &&
    Object.keys(record(display.causalityGraph)).length > 0
      ? record(display.causalityGraph)
      : undefined;
  const graphBytes = graph ? JSON.stringify(graph).length : 0;
  // A failed compile arrives as a successful tool call whose display says
  // ok:false / errorCount>0 (POC-verified: `success` stays true), so the
  // display flags - not the tool envelope - decide the terminal state.
  const isCreateDisplay = display.kind === "create_workflow";
  const errorCount = isCreateDisplay ? Number(display.errorCount) || 0 : 0;
  const displayFailed =
    isCreateDisplay && (display.ok === false || errorCount > 0);
  const failed = Boolean(error) || displayFailed;
  const failureMessage =
    error ??
    (displayFailed
      ? `Workflow script has errors${errorCount > 0 ? ` (${errorCount})` : ""}.`
      : undefined);
  return {
    v: 1,
    state: failed ? "failed" : "done",
    ok: isCreateDisplay ? display.ok !== false : r.success !== false,
    ...(content ? { summary: content.slice(0, 2000) } : {}),
    ...(runId ? { runId } : {}),
    ...(scriptPath ? { scriptPath } : {}),
    ...(failureMessage ? { error: failureMessage.slice(0, 2000) } : {}),
    ...(graph && graphBytes <= 256 * 1024
      ? { graph }
      : graph
        ? { graphTruncated: true }
        : {}),
  };
}

/** Presentation-aware caps for model-generated text carried in rich rows. */
const cap = (value: string, limit = 64 * 1024) => value.slice(0, limit);

type Specialized = { item: DeltaItemShape; presentation: DeltaPresentation };

/**
 * Maps known native coding tools onto bb's rich row shapes. Unknown tools and
 * inputs without the expected fields fall back to the generic tool row; a
 * failed close also falls back so the error stays visible.
 */
function specialize(
  name: string,
  input: unknown,
  toolCallId: string,
): Specialized | undefined {
  const args = record(input);
  const path = text(args.file_path) || text(args.path);
  switch (name) {
    case "Read":
      if (!path) return undefined;
      return {
        item: { type: "fileRead", path },
        presentation: sdkFileReadPresentation(path),
      };
    case "Edit": {
      if (!path) return undefined;
      return {
        item: {
          type: "fileChange",
          changes: [
            {
              kind: "update",
              path,
              ...(text(args.old_string)
                ? { oldText: cap(text(args.old_string)) }
                : {}),
              ...(text(args.new_string)
                ? { newText: cap(text(args.new_string)) }
                : {}),
            },
          ],
        },
        presentation: toolPresentation("Edit", path),
      };
    }
    case "Write":
      if (!path) return undefined;
      return {
        item: {
          type: "fileChange",
          changes: [
            {
              kind: "update",
              path,
              ...(text(args.content)
                ? { newText: cap(text(args.content)) }
                : {}),
            },
          ],
        },
        presentation: toolPresentation("Write", path),
      };
    case "Grep":
    case "Glob": {
      const query = text(args.pattern) || text(args.query);
      if (!query) return undefined;
      const mode = name === "Grep" ? "content" : "path";
      return {
        item: {
          type: "search",
          query,
          mode,
          ...(path ? { path } : {}),
        },
        presentation: sdkSearchPresentation({ mode, query }),
      };
    }
    case "WebSearch": {
      const query = text(args.query);
      if (!query) return undefined;
      return {
        item: { type: "webSearch", queries: [query] },
        presentation: sdkWebSearchPresentation(query),
      };
    }
    case "WebFetch": {
      const url = text(args.url);
      if (!url) return undefined;
      return {
        item: {
          type: "webFetch",
          url,
          pattern: text(args.pattern) || null,
          ...(text(args.prompt) ? { prompt: text(args.prompt) } : {}),
        },
        presentation: sdkWebFetchPresentation(url),
      };
    }
    case "TodoWrite": {
      const todos = Array.isArray(args.todos) ? args.todos : [];
      const steps: Array<{
        step: string;
        status?: "completed" | "active" | "pending";
      }> = [];
      for (const todo of todos) {
        const entry = record(todo);
        const step = text(entry.content) || text(entry.subject);
        if (!step) continue;
        const status = text(entry.status);
        steps.push({
          step,
          ...(status
            ? {
                status:
                  status === "completed"
                    ? ("completed" as const)
                    : status === "in_progress"
                      ? ("active" as const)
                      : ("pending" as const),
              }
            : {}),
        });
      }
      if (!steps.length) return undefined;
      return {
        item: { type: "planSteps", steps },
        presentation: sdkPlanStepsPresentation(steps),
      };
    }
    case "Task": {
      const label =
        text(args.description) || text(args.subagent_type) || "Subagent";
      return {
        item: {
          type: "delegation",
          label: cap(label, 4000),
          childRef: toolCallId,
          background: false,
        },
        presentation: toolPresentation(label),
      };
    }
    default:
      return undefined;
  }
}

/** One translator per turn. Only the desktop-continuous event lane is consumed. */
export class Timeline {
  private streams = new Map<string, "agentMessage" | "reasoningText">();
  private tools = new Map<
    string,
    {
      name: string;
      input: unknown;
      parentRef?: string;
      output?: string;
      specialized?: Specialized;
    }
  >();
  private hasText = false;
  private toolInputs = new Map<string, unknown>();
  private workflowRows = new Map<string, { parentRef?: string }>();
  constructor(
    private emit: (deltas: ThreadDelta[]) => void,
    private cwd = "",
  ) {}

  event(type: string, raw: unknown) {
    const p = record(raw);
    if (type === "model.streaming") {
      const kind = text(p.kind);
      if (
        kind === "tool_call" &&
        typeof p.toolCallId === "string" &&
        p.input !== undefined
      ) {
        this.toolInputs.set(p.toolCallId, p.input);
        if (this.toolInputs.size > 1024)
          this.toolInputs.delete(this.toolInputs.keys().next().value!);
        return;
      }
      if (!/^(text|reasoning)_(delta|end)$/.test(kind)) return;
      const channel = kind.startsWith("reasoning")
        ? "reasoningText"
        : "agentMessage";
      const id = `${text(p.assistantMessageId, "message")}:${text(p.partId, channel)}`;
      const key = { providerItemId: id };
      if (kind.endsWith("_delta") && typeof p.delta === "string") {
        this.streams.set(id, channel);
        if (channel === "agentMessage") this.hasText = true;
        this.emit([{ kind: "item.textDelta", key, channel, text: p.delta }]);
      } else if (this.streams.has(id)) {
        this.emit([{ kind: "item.textClose", key, channel }]);
        this.streams.delete(id);
      }
    } else if (type === "tool.updated") {
      const id = text(p.toolCallId);
      if (!id) return;
      const parentRef =
        this.tools.get(id)?.parentRef ??
        // Workflow rows keep their saved parent here; the result event may
        // omit the attribution the scheduled event carried.
        this.workflowRows.get(id)?.parentRef ??
        text(p.parentToolCallId);
      const key = { providerItemId: id, ...(parentRef ? { parentRef } : {}) };
      if (p.kind === "scheduled" || p.kind === "started") {
        if (this.tools.has(id) || this.workflowRows.has(id)) return;
        const name = text(p.toolName, "ZCode tool");
        const input = p.input ?? this.toolInputs.get(id);
        this.toolInputs.delete(id);
        // Dynamic-workflow authoring rows are the plugin's own extension kind:
        // the frontend renderer draws the causality graph from the result
        // payload instead of the generic tool body.
        if (WORKFLOW_TOOL_NAMES.has(name)) {
          this.workflowRows.set(id, {
            ...(parentRef ? { parentRef } : {}),
          });
          const payload = workflowPayloadRunning(input);
          this.emit([
            {
              kind: "item.open",
              key,
              item: {
                type: "extension",
                kind: WORKFLOW_GRAPH_EXTENSION_KIND,
                payload: json(payload),
              },
              presentation: workflowPresentation(
                typeof payload.title === "string" ? payload.title : undefined,
              ),
            },
          ]);
          return;
        }
        const specialized =
          name === "Bash" && typeof record(input).command === "string"
            ? undefined
            : specialize(name, input, id);
        this.tools.set(id, {
          name,
          input,
          ...(parentRef ? { parentRef } : {}),
          ...(specialized ? { specialized } : {}),
        });
        this.emit([
          {
            kind: "item.open",
            key,
            item:
              name === "Bash" && typeof record(input).command === "string"
                ? {
                    type: "command",
                    command: text(record(input).command),
                    cwd: this.cwd,
                  }
                : (specialized?.item ?? {
                    type: "tool",
                    tool: name,
                    args: input,
                  }),
            presentation: specialized?.presentation ?? toolPresentation(name),
          },
        ]);
      } else if (p.kind === "progress") {
        const tool = this.tools.get(id);
        if (tool?.name !== "Bash") return;
        const output = [text(p.stdoutTail), text(p.stderrTail)]
          .filter(Boolean)
          .join("\n")
          .slice(-64 * 1024);
        if (output && output !== tool.output) {
          tool.output = output;
          this.emit([{ kind: "command.outputSnapshot", key, text: output }]);
        }
      } else if (p.kind === "result" || p.kind === "error") {
        const workflowRow = this.workflowRows.get(id);
        if (workflowRow) {
          this.workflowRows.delete(id);
          const error =
            p.kind === "error"
              ? text(record(p.error).message, "Tool failed")
              : record(p.result).isError === true ||
                  record(p.result).success === false
                ? "Tool reported failure"
                : undefined;
          const payload = workflowPayloadDone(p.result, error);
          this.emit([
            {
              kind: "item.close",
              key,
              status: payload.state === "failed" ? "failed" : "completed",
              item: {
                type: "extension",
                kind: WORKFLOW_GRAPH_EXTENSION_KIND,
                payload: json(payload),
              },
              presentation: workflowPresentation(
                typeof payload.runId === "string"
                  ? payload.runId
                  : typeof payload.title === "string"
                    ? payload.title
                    : undefined,
              ),
            },
          ]);
          return;
        }
        const tool = this.tools.get(id) ?? {
          name: text(p.toolName, "ZCode tool"),
          input: undefined,
        };
        const result = record(p.result);
        const finalOutput =
          record(result.display).kind === "bash_output"
            ? text(record(result.display).output)
            : [text(result.stdout), text(result.stderr)]
                .filter(Boolean)
                .join("\n") ||
              text(result.content) ||
              tool.output;
        const error =
          p.kind === "error"
            ? text(record(p.error).message, "Tool failed")
            : result.isError === true || result.success === false
              ? "Tool reported failure"
              : undefined;
        const commandOutput = [finalOutput, error].filter(Boolean).join("\n");
        const spec = tool.specialized;
        const closedItem: DeltaItemShape =
          tool.name === "Bash" && typeof record(tool.input).command === "string"
            ? {
                type: "command",
                command: text(record(tool.input).command),
                cwd: this.cwd,
                ...(typeof result.exitCode === "number"
                  ? { exitCode: result.exitCode }
                  : {}),
                ...(commandOutput
                  ? { aggregatedOutput: commandOutput.slice(-64 * 1024) }
                  : {}),
                ...(typeof p.duration === "number"
                  ? { durationMs: p.duration }
                  : {}),
              }
            : error || !spec
              ? {
                  type: "tool",
                  tool: tool.name,
                  args: tool.input,
                  result: p.result,
                  ...(error ? { error } : {}),
                  ...(typeof p.duration === "number"
                    ? { durationMs: p.duration }
                    : {}),
                }
              : spec.item.type === "delegation" &&
                  tool.name === "Task" &&
                  finalOutput
                ? { ...spec.item, summary: cap(finalOutput, 4000) }
                : spec.item;
        this.emit([
          {
            kind: "item.close",
            key,
            status: error ? "failed" : "completed",
            item: closedItem,
            presentation: spec?.presentation ?? toolPresentation(tool.name),
          },
        ]);
        this.tools.delete(id);
      }
    }
  }

  finish(
    status: "completed" | "failed" | "interrupted",
    response?: string,
    providerCheckpointId?: string,
  ) {
    const deltas: ThreadDelta[] = [];
    for (const [id, channel] of this.streams)
      deltas.push({
        kind: "item.textClose",
        key: { providerItemId: id },
        channel,
      });
    this.streams.clear();
    this.toolInputs.clear();
    for (const [id, tool] of this.tools)
      deltas.push({
        kind: "item.close",
        key: {
          providerItemId: id,
          ...(tool.parentRef ? { parentRef: tool.parentRef } : {}),
        },
        status: status === "completed" ? "failed" : status,
        item:
          tool.name === "Bash" && typeof record(tool.input).command === "string"
            ? {
                type: "command",
                command: text(record(tool.input).command),
                cwd: this.cwd,
                ...(tool.output ? { aggregatedOutput: tool.output } : {}),
              }
            : {
                type: "tool",
                tool: tool.name,
                args: tool.input,
                error: "ZCode ended before the tool returned.",
              },
        presentation: toolPresentation(tool.name),
      });
    this.tools.clear();
    // Workflow rows live outside `tools`; an interrupted turn must close
    // them too or the renderer keeps a stale "running" row forever.
    for (const [id, row] of this.workflowRows)
      deltas.push({
        kind: "item.close",
        key: {
          providerItemId: id,
          ...(row.parentRef ? { parentRef: row.parentRef } : {}),
        },
        status: status === "completed" ? "failed" : status,
        item: {
          type: "extension",
          kind: WORKFLOW_GRAPH_EXTENSION_KIND,
          payload: json({
            v: 1,
            state: "failed",
            error: "ZCode ended before the workflow returned.",
          }),
        },
        presentation: workflowPresentation(),
      });
    this.workflowRows.clear();
    if (!this.hasText && response?.trim())
      deltas.push({
        kind: "item.textClose",
        key: { channel: "assistant" },
        channel: "agentMessage",
        text: response,
      });
    deltas.push({
      kind: "turn.boundary",
      status,
      ...(providerCheckpointId ? { providerCheckpointId } : {}),
    });
    this.emit(deltas);
  }
}
