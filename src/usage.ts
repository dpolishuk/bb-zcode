import {
  addTokenUsage,
  ZERO_TOKEN_USAGE,
  type ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";
import { record } from "./protocol.js";

const count = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;

export class Usage {
  private total = { ...ZERO_TOKEN_USAGE };

  constructor(restored?: unknown) {
    if (restored) this.turn(restored, null);
  }

  turn(raw: unknown, contextWindow: number | null): ThreadDelta[] {
    const u = record(raw);
    const inputTokens = count(u.inputTokens),
      outputTokens = count(u.outputTokens);
    if (inputTokens === undefined || outputTokens === undefined) return [];
    const cacheRead = count(u.cacheReadTokens),
      cacheWrite = count(u.cacheWriteTokens) ?? count(u.cacheCreationTokens);
    const last = {
      inputTokens,
      outputTokens,
      totalTokens: count(u.totalTokens) ?? inputTokens + outputTokens,
      cachedInputTokens:
        count(u.cacheTokens) ?? (cacheRead ?? 0) + (cacheWrite ?? 0),
      reasoningOutputTokens: count(u.reasoningTokens) ?? 0,
      ...(cacheRead !== undefined ? { cacheReadInputTokens: cacheRead } : {}),
      ...(cacheWrite !== undefined
        ? { cacheWriteInputTokens: cacheWrite }
        : {}),
    };
    this.total = addTokenUsage(this.total, last);
    return [
      {
        kind: "usage",
        last,
        total: { ...this.total },
        modelContextWindow: contextWindow,
      },
    ];
  }

  context(raw: unknown): ThreadDelta[] {
    const p = record(raw),
      used = count(p.contextUsed),
      size = count(p.contextWindow);
    if (used === undefined || size === undefined || size === 0) return [];
    return [
      {
        kind: "contextWindow",
        used,
        size,
        estimated: true,
        attach: "currentOrLast",
      },
    ];
  }
}
