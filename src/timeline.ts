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
  private tools = new Map<string, { name: string; input: unknown }>();
  private hasText = false;
  constructor(private emit: (deltas: ThreadDelta[]) => void) {}

  event(type: string, raw: unknown) {
    const p = record(raw);
    if (type === "model.streaming") {
      const kind = text(p.kind);
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
      const key = { providerItemId: id };
      if (p.kind === "scheduled" || p.kind === "started") {
        if (this.tools.has(id)) return;
        const name = text(p.toolName, "ZCode tool");
        this.tools.set(id, { name, input: p.input });
        this.emit([
          {
            kind: "item.open",
            key,
            item: { type: "tool", tool: name, args: p.input },
            presentation: toolPresentation(name),
          },
        ]);
      } else if (p.kind === "result" || p.kind === "error") {
        const tool = this.tools.get(id) ?? {
          name: text(p.toolName, "ZCode tool"),
          input: undefined,
        };
        const result = record(p.result);
        const error =
          p.kind === "error"
            ? text(record(p.error).message, "Tool failed")
            : result.isError === true || result.success === false
              ? "Tool reported failure"
              : undefined;
        this.emit([
          {
            kind: "item.close",
            key,
            status: error ? "failed" : "completed",
            item: {
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

  finish(status: "completed" | "failed" | "interrupted", response?: string) {
    const deltas: ThreadDelta[] = [];
    for (const [id, channel] of this.streams)
      deltas.push({
        kind: "item.textClose",
        key: { providerItemId: id },
        channel,
      });
    this.streams.clear();
    for (const [id, tool] of this.tools)
      deltas.push({
        kind: "item.close",
        key: { providerItemId: id },
        status: status === "completed" ? "failed" : status,
        item: {
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
    deltas.push({ kind: "turn.boundary", status });
    this.emit(deltas);
  }
}
