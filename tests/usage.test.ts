import { describe, expect, it } from "vitest";
import { Usage, contextSnapshot, rateLimitFailure } from "../src/usage.js";
import type { UsageWindow } from "../src/coding-plan.js";

const windows = (overrides: Partial<UsageWindow>[]): UsageWindow[] =>
  overrides.map((w) => ({
    label: w.label ?? "5-hour window",
    usedPercent: w.usedPercent ?? 0,
    resetsAt: w.resetsAt ?? null,
  }));

describe("contextSnapshot", () => {
  const composition = {
    sessionId: "native-session",
    revision: 3,
    phase: "request",
    measuredAt: 1_700_000_000_000,
    model: { providerId: "test", modelId: "model", contextWindow: 200000 },
    tokenMethod: "estimated",
    estimatedTokens: 900,
    providerContextTokens: 1000,
    freeTokens: 199000,
    categories: [
      {
        id: "system_prompt",
        tokens: 300,
        items: [{ name: "root prompt", tokens: 300 }],
      },
      {
        id: "messages",
        tokens: 600,
        items: [
          { name: "user: hello", tokens: 350 },
          { name: "assistant: world", tokens: 250 },
        ],
      },
      { id: "deferred_tool_schemas", tokens: 100, items: [] },
      { id: "not-a-category", tokens: 1 },
    ],
  };

  it("maps a request-phase composition onto the bb snapshot grammar", () => {
    expect(
      contextSnapshot(composition, {
        size: null,
        sessionId: "native-session",
        turnId: "turn-1",
      }),
    ).toEqual({
      autoCompactAtTokens: null,
      capturedAt: new Date(1_700_000_000_000).toISOString(),
      categories: [
        {
          entries: [
            { id: "system_prompt:0", label: "root prompt", tokens: 300 },
          ],
          id: "system_prompt",
          kind: "reserved",
          label: "System prompt",
          tokens: 300,
        },
        {
          entries: [
            { id: "messages:0", label: "user: hello", tokens: 350 },
            { id: "messages:1", label: "assistant: world", tokens: 250 },
          ],
          id: "messages",
          kind: "used",
          label: "Messages",
          tokens: 600,
        },
        {
          entries: [],
          id: "deferred_tool_schemas",
          kind: "deferred",
          label: "Deferred tool schemas",
          tokens: 100,
        },
        {
          entries: [],
          id: "free",
          kind: "free",
          label: "Free",
          tokens: 199000,
        },
      ],
      contextWindowTokens: 200000,
      estimated: true,
      model: "test/model",
      providerSessionId: "native-session",
      providerTurnId: "turn-1",
      usedTokens: 1000,
    });
  });

  it("falls back to the provided window and drops unusable measurements", () => {
    const noWindow = structuredClone(composition);
    (noWindow.model as { contextWindow: number | null }).contextWindow = null;
    expect(
      contextSnapshot(noWindow, {
        size: 100000,
        sessionId: "s",
        turnId: null,
      }),
    ).toMatchObject({ contextWindowTokens: 100000 });

    const draft = structuredClone(composition);
    draft.phase = "draft-preview";
    expect(
      contextSnapshot(draft, { size: 1000, sessionId: "s", turnId: null }),
    ).toBeUndefined();

    const modelless = structuredClone(composition);
    modelless.model = {
      providerId: "",
      modelId: "",
      contextWindow: 1,
    } as typeof composition.model;
    expect(
      contextSnapshot(modelless, { size: 1000, sessionId: "s", turnId: null }),
    ).toBeUndefined();
  });
});

describe("rateLimitFailure", () => {
  it.each([
    "ZCode: Provider rate limited the model request.",
    "ZCode: HTTP 429 too many requests",
    "ZCode: HTTP/1.1 429",
    "ZCode: 请求被限流 (429)",
    "ZCode: status code 429 from the provider",
  ])("matches %s", (message) => {
    expect(rateLimitFailure(message)).toBe(true);
  });

  it.each([
    "ZCode: Model request exceeded the provider context window.",
    "ZCode: Provider authentication failed.",
    "ZCode: The API key status is not active.",
    "ZCode: account request failed or returned an invalid response.",
    // CodingPlanHost.request() surfaces explicit account-service HTTP
    // errors; they are account failures, not model rate limits.
    "ZCode Coding Plan: account service returned HTTP 429. Reconnect Coding Plan in ZCode and retry.",
    "ZCode: Provider returned a server error.",
    // A bare 429 quoted for another reason must not tag the turn retryable.
    "ZCode: 429 files were scanned before the failure.",
    "ZCode: exit code 429 rows remained unread",
  ])("does not match %s", (message) => {
    expect(rateLimitFailure(message)).toBe(false);
  });
});

describe("Usage.rateLimits", () => {
  const usage = new Usage();

  it("reports a blocked subscription window with reset times", () => {
    const reset = Date.now() + 3_600_000;
    const deltas = usage.rateLimits(
      windows([
        {
          usedPercent: 100,
          resetsAt: new Date(reset).toISOString(),
        },
        { label: "Weekly window", usedPercent: 40, resetsAt: null },
      ]),
      "ZCode: Provider rate limited the model request.",
    );
    expect(deltas).toHaveLength(1);
    const delta = deltas[0] as {
      kind: string;
      rateLimits: Record<string, unknown>;
    };
    expect(delta.kind).toBe("provider.rateLimits");
    expect(delta.rateLimits).toMatchObject({
      kind: "subscription-window",
      providerId: "zcode",
      status: "blocked",
      reachedReason: "ZCode: Provider rate limited the model request.",
      overageReason: null,
      overageStatus: null,
    });
    expect(delta.rateLimits.windows).toEqual([
      {
        label: "5-hour window",
        providerKey: null,
        resetsAtMs: reset,
        status: "blocked",
      },
      {
        label: "Weekly window",
        providerKey: null,
        resetsAtMs: null,
        status: "allowed",
      },
    ]);
  });

  it("reports a warning without a blocked window below the threshold", () => {
    const deltas = usage.rateLimits(
      windows([{ usedPercent: 85, resetsAt: new Date().toISOString() }]),
      "rate limited",
    );
    expect(deltas).toHaveLength(1);
    expect(
      (deltas[0] as { rateLimits: Record<string, unknown> }).rateLimits.status,
    ).toBe("warning");
  });

  it("stays silent when no window is near its limit or has no resets", () => {
    expect(
      usage.rateLimits(windows([{ usedPercent: 10 }]), "rate limited"),
    ).toEqual([]);
    expect(
      usage.rateLimits(
        windows([{ usedPercent: 100, resetsAt: null }]),
        "rate limited",
      ),
    ).toEqual([]);
  });

  it("excludes the MCP allowance from model retry windows", () => {
    const reset = new Date(Date.now() + 3_600_000).toISOString();
    const mcpReset = new Date(Date.now() + 86_400_000).toISOString();
    // Only the MCP quota is exhausted: no retry state at all.
    expect(
      usage.rateLimits(
        windows([{ label: "MCP quota", usedPercent: 100, resetsAt: mcpReset }]),
        "rate limited",
      ),
    ).toEqual([]);
    // Both exhausted: the state schedules against the model window's reset,
    // not the later MCP one.
    const deltas = usage.rateLimits(
      windows([
        { usedPercent: 100, resetsAt: reset },
        { label: "MCP quota", usedPercent: 100, resetsAt: mcpReset },
      ]),
      "rate limited",
    );
    const state = (deltas[0] as { rateLimits: Record<string, unknown> })
      .rateLimits;
    expect(state.windows).toEqual([
      {
        label: "5-hour window",
        providerKey: null,
        resetsAtMs: Date.parse(reset),
        status: "blocked",
      },
    ]);
  });

  it("keeps a blocked aggregate when the blocked window's timestamp is malformed", () => {
    const deltas = usage.rateLimits(
      windows([
        { usedPercent: 100, resetsAt: "not-a-timestamp" },
        {
          label: "Weekly window",
          usedPercent: 25,
          resetsAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ]),
      "rate limited",
    );
    expect(deltas).toHaveLength(1);
    const state = (deltas[0] as { rateLimits: Record<string, unknown> })
      .rateLimits;
    expect(state.status).toBe("blocked");
    expect(state.windows).toEqual([
      {
        label: "Weekly window",
        providerKey: null,
        resetsAtMs: (state.windows as Array<{ resetsAtMs: number }>)[0]
          .resetsAtMs,
        status: "allowed",
      },
    ]);
  });
});
