import type {
  ThreadDelta,
  DeltaPresentation,
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

/** One translator per turn. Only the desktop-continuous event lane is consumed. */
export class Timeline {
  private streams = new Map<string, "agentMessage" | "reasoningText">();
  private tools = new Map<
    string,
    { name: string; input: unknown; parentRef?: string; output?: string }
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
        this.tools.set(id, {
          name,
          input,
          ...(parentRef ? { parentRef } : {}),
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
                : { type: "tool", tool: name, args: input },
            presentation: toolPresentation(name),
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
        this.emit([
          {
            kind: "item.close",
            key,
            status: error ? "failed" : "completed",
            item:
              tool.name === "Bash" &&
              typeof record(tool.input).command === "string"
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
                : {
                    type: "tool",
                    tool: tool.name,
                    args: tool.input,
                    result: p.result,
                    ...(error ? { error } : {}),
                    ...(typeof p.duration === "number"
                      ? { durationMs: p.duration }
                      : {}),
                  },
            presentation: toolPresentation(tool.name),
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
