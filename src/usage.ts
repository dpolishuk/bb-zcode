import {
  addTokenUsage,
  ZERO_TOKEN_USAGE,
  type ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";
import { record } from "./protocol.js";
import type { UsageWindow } from "./coding-plan.js";

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

  context(raw: unknown, windowOverride?: number): ThreadDelta[] {
    const p = record(raw),
      used = count(p.contextUsed),
      size = count(windowOverride ?? p.contextWindow);
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

  /**
   * The subscription-window rate-limit state bb's Provider retry plugin needs
   * to schedule a retry at the window reset: it only acts when the state is
   * `blocked` with a `subscription-window` kind and a window carrying
   * `resetsAtMs`. Windows below the blocked threshold keep the delta for
   * visibility (warning at 80+) but schedule nothing.
   */
  rateLimits(windows: UsageWindow[], reason: string): ThreadDelta[] {
    const state = rateLimitState(windows, reason);
    return state ? [{ kind: "provider.rateLimits", rateLimits: state }] : [];
  }
}

/** True when a failed turn's message looks like a provider rate limit. */
export function rateLimitFailure(message: string): boolean {
  if (
    /context window|authentication|API key status|account request/i.test(
      message,
    )
  )
    return false;
  // A bare "429" anywhere would over-match failure text that quotes the
  // number for another reason; only explicit HTTP-status forms count.
  return /\brate[ -]?limit|too many requests|http(?:\/[\d.]+)?\s+429\b|\(429\)|status(?:\s*code)?[:=]?\s*429\b/i.test(
    message,
  );
}

function rateLimitState(
  windows: UsageWindow[],
  reason: string,
): Extract<ThreadDelta, { kind: "provider.rateLimits" }>["rateLimits"] | null {
  const mapped = windows.map((w) => ({
    label: w.label,
    providerKey: null,
    resetsAtMs: w.resetsAt === null ? null : Date.parse(w.resetsAt),
    status:
      w.usedPercent >= 100
        ? ("blocked" as const)
        : w.usedPercent >= 80
          ? ("warning" as const)
          : ("allowed" as const),
  }));
  // The aggregate status must reflect every window: a blocked window with a
  // malformed timestamp still blocks, so it is dropped from the emitted rows
  // but not from the status computation.
  const status = mapped.some((w) => w.status === "blocked")
    ? "blocked"
    : mapped.some((w) => w.status === "warning")
      ? "warning"
      : "allowed";
  const rows = mapped.filter(
    (w) => w.resetsAtMs === null || Number.isFinite(w.resetsAtMs),
  );
  // The state as a whole needs at least one known reset for the retry
  // plugin to schedule.
  if (status === "allowed" || !rows.some((w) => w.resetsAtMs !== null))
    return null;
  return {
    kind: "subscription-window",
    overageReason: null,
    overageStatus: null,
    providerId: "zcode",
    reachedReason: reason,
    status,
    windows: rows,
  };
}
