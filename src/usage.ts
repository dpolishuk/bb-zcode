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
  return /\brate[ -]?limit|too many requests|http 429\b|\(429\)|\b429\b/i.test(
    message,
  );
}

function rateLimitState(
  windows: UsageWindow[],
  reason: string,
): Extract<ThreadDelta, { kind: "provider.rateLimits" }>["rateLimits"] | null {
  const rows = windows
    .map((w) => ({
      label: w.label,
      providerKey: null,
      resetsAtMs: w.resetsAt === null ? null : Date.parse(w.resetsAt),
      status:
        w.usedPercent >= 100
          ? ("blocked" as const)
          : w.usedPercent >= 80
            ? ("warning" as const)
            : ("allowed" as const),
    }))
    // A malformed timestamp drops only its own window; the state as a whole
    // needs at least one known reset for the retry plugin to schedule.
    .filter((w) => w.resetsAtMs === null || Number.isFinite(w.resetsAtMs));
  if (!rows.some((w) => w.resetsAtMs !== null)) return null;
  const status = rows.some((w) => w.status === "blocked")
    ? "blocked"
    : rows.some((w) => w.status === "warning")
      ? "warning"
      : "allowed";
  if (status === "allowed") return null;
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
