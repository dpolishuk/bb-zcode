import {
  addTokenUsage,
  ZERO_TOKEN_USAGE,
  type ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";
import { record, text } from "./protocol.js";
import type { UsageWindow } from "./coding-plan.js";

const count = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;

/** bb's rich context snapshot carried on the contextWindow delta. */
export interface ContextSnapshot {
  autoCompactAtTokens: number | null;
  capturedAt: string;
  categories: Array<{
    entries: Array<{ id: string; label: string; tokens: number }>;
    id: string;
    kind: "deferred" | "free" | "reserved" | "used";
    label: string;
    tokens: number;
  }>;
  contextWindowTokens: number;
  estimated: boolean;
  model: string;
  providerSessionId: string;
  providerTurnId: string | null;
  usedTokens: number;
}

// Native context-composition fine categories (upstream
// zcode-protocol-v4/context-composition) mapped onto bb's four snapshot
// kinds: conversation content is used, static prompt overhead is reserved,
// not-yet-loaded tool schemas are deferred.
const SNAPSHOT_KIND_BY_CATEGORY: Record<
  string,
  ContextSnapshot["categories"][number]["kind"]
> = {
  messages: "used",
  compact_summary: "used",
  reminders: "used",
  meta_user_context: "used",
  system_prompt: "reserved",
  tool_prompt: "reserved",
  skills: "reserved",
  system_tool_schemas: "reserved",
  mcp_tool_schemas: "reserved",
  app_tool_schemas: "reserved",
  deferred_tool_schemas: "deferred",
};
const CATEGORY_LABELS: Record<string, string> = {
  system_prompt: "System prompt",
  meta_user_context: "User context",
  skills: "Skills",
  tool_prompt: "Tool prompt",
  system_tool_schemas: "System tool schemas",
  mcp_tool_schemas: "MCP tool schemas",
  app_tool_schemas: "App tool schemas",
  deferred_tool_schemas: "Deferred tool schemas",
  reminders: "Reminders",
  compact_summary: "Compact summary",
  messages: "Messages",
};

/**
 * Maps one native `v4/conversation/contextComposition` measurement onto
 * bb's rich context snapshot. Only request-phase measurements map; each
 * native category keeps its identity with the projected kind, and the
 * native `freeTokens` becomes a synthetic free category. Returns undefined
 * for anything that is not a usable request-phase measurement - callers
 * keep their plain contextWindow delta in that case.
 */
export function contextSnapshot(
  composition: unknown,
  fallback: {
    size: number | null | undefined;
    sessionId: string;
    turnId: string | null;
  },
): ContextSnapshot | undefined {
  const c = record(composition);
  if (text(c.phase) !== "request") return undefined;
  const model = record(c.model);
  const providerId = text(model.providerId),
    modelId = text(model.modelId);
  if (!providerId || !modelId) return undefined;
  // The bridge-passed window carries the selected reporting budget (e.g. a
  // 256k variant of a 1M model); the snapshot must report against it, not
  // the native window, and the free bucket is recomputed from it.
  const nativeWindow = count(model.contextWindow) ?? null;
  const size = fallback.size ?? nativeWindow;
  if (size === null || size === 0) return undefined;
  const entries = (Array.isArray(c.categories) ? c.categories : [])
    .map(record)
    .map((category) => {
      const id = text(category.id);
      const kind = SNAPSHOT_KIND_BY_CATEGORY[id];
      const tokens = count(category.tokens);
      if (!kind || tokens === undefined) return undefined;
      const items = Array.isArray(category.items) ? category.items : [];
      return {
        entries: items.slice(0, 50).map((item, index) => {
          const row = record(item);
          return {
            id: `${id}:${index}`,
            label: text(row.name, id).slice(0, 200),
            tokens: count(row.tokens) ?? 0,
          };
        }),
        id,
        kind,
        label: CATEGORY_LABELS[id] ?? id,
        tokens,
      };
    })
    .filter(
      (category): category is ContextSnapshot["categories"][number] =>
        category !== undefined,
    );
  const usedTokens =
    count(c.providerContextTokens) ?? count(c.estimatedTokens) ?? 0;
  const free = Math.max(0, size - usedTokens);
  const measuredAt = count(c.measuredAt);
  return {
    autoCompactAtTokens: null,
    capturedAt: new Date(measuredAt ?? Date.now()).toISOString(),
    categories: withFree(entries, free),
    contextWindowTokens: size,
    estimated: true,
    model: `${providerId}/${modelId}`,
    providerSessionId: text(c.sessionId) || fallback.sessionId,
    providerTurnId: fallback.turnId,
    usedTokens,
  };
}

function withFree(
  categories: ContextSnapshot["categories"],
  free: number | null,
): ContextSnapshot["categories"] {
  if (free === null || free <= 0) return categories;
  return [
    ...categories,
    {
      entries: [],
      id: "free",
      kind: "free",
      label: "Free",
      tokens: free,
    },
  ];
}

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

  context(
    raw: unknown,
    windowOverride?: number,
    snapshot?: ContextSnapshot,
  ): ThreadDelta[] {
    const p = record(raw),
      // A composition snapshot carries its own ring-aligned numbers; it can
      // supply the meter when the projection read has none.
      used = count(p.contextUsed) ?? snapshot?.usedTokens,
      size =
        count(windowOverride ?? p.contextWindow) ??
        snapshot?.contextWindowTokens;
    if (used === undefined || size === undefined || size === 0) return [];
    return [
      {
        kind: "contextWindow",
        used,
        size,
        estimated: true,
        attach: "currentOrLast",
        ...(snapshot ? { snapshot } : {}),
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
    /context window|authentication|API key status|account request|account service/i.test(
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
  // The MCP allowance is a separate TIME_LIMIT that does not govern model
  // requests: an exhausted MCP quota must not postpone a model retry. It
  // stays in the provider/usage display but never enters the retry state.
  const modelWindows = windows.filter((w) => w.label !== "MCP quota");
  const mapped = modelWindows.map((w) => ({
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
