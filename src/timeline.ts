import type {
  ThreadDelta,
  DeltaPresentation,
  DeltaItemShape,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  experimental_fileReadPresentation as sdkFileReadPresentation,
  experimental_searchPresentation as sdkSearchPresentation,
  experimental_webSearchPresentation as sdkWebSearchPresentation,
  experimental_webFetchPresentation as sdkWebFetchPresentation,
  experimental_planStepsPresentation as sdkPlanStepsPresentation,
} from "@get-bb/plugin-sdk/provider-bridge";
import { record, text } from "./protocol.js";

export const toolPresentation = (
  name: string,
  detail?: string,
): DeltaPresentation => ({
  label: { pending: `Running ${name}`, completed: name },
  icon: { glyph: "Wrench" },
  ...(detail ? { detail: detail.slice(0, 4000) } : {}),
});

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
        this.tools.get(id)?.parentRef ?? text(p.parentToolCallId);
      const key = { providerItemId: id, ...(parentRef ? { parentRef } : {}) };
      if (p.kind === "scheduled" || p.kind === "started") {
        if (this.tools.has(id)) return;
        const name = text(p.toolName, "ZCode tool");
        const input = p.input ?? this.toolInputs.get(id);
        this.toolInputs.delete(id);
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
