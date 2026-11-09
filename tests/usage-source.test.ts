import { describe, expect, it, vi } from "vitest";
import type { ExperimentalPluginRpcHandlersWithContext } from "@get-bb/plugin-sdk";
import {
  registerUsageSource,
  type UsageSourceDeps,
} from "../src/usageSource.js";
import { usageSourceRpcContract } from "../src/usageContract.js";

type Handlers = ExperimentalPluginRpcHandlersWithContext<
  typeof usageSourceRpcContract
>;

function fixture(overrides: Partial<UsageSourceDeps> = {}) {
  let now = 1_000_000;
  const usageLimits = vi.fn(
    async () =>
      ({
        zcode: {
          status: "ok",
          accountEmail: null,
          planLabel: "GLM Coding Max",
          windows: [
            {
              label: "5-hour window",
              usedPercent: 8,
              resetsAt: "2026-11-09T19:00:37.483Z",
            },
            { label: "Weekly window", usedPercent: 23, resetsAt: null },
            {
              label: "MCP quota",
              usedPercent: 1,
              resetsAt: "2026-12-01T07:48:13.981Z",
            },
          ],
        },
      }) as Awaited<ReturnType<UsageSourceDeps["usageLimits"]>>,
  );
  const deps: UsageSourceDeps = {
    hosts: {
      list: async () => [
        {
          id: "mach",
          name: "Deepol's Mac",
          type: "persistent",
          status: "connected",
        },
        {
          id: "tmp",
          name: "Ephemeral",
          type: "ephemeral",
          status: "connected",
        },
        {
          id: "off",
          name: "Offline",
          type: "persistent",
          status: "disconnected",
        },
      ],
    },
    providers: {
      list: async ({ hostId }) =>
        hostId === "mach"
          ? [
              {
                id: "zcode",
                pluginId: "zcode",
                displayName: "ZCode",
              },
              { id: "codex", pluginId: "provider-codex", displayName: "Codex" },
            ]
          : [],
    },
    usageLimits,
    now: () => now,
    ...overrides,
  };
  let handlers!: Handlers;
  let options!: {
    experimental_discoverable: boolean;
    experimental_description: string;
  };
  registerUsageSource((h, o) => {
    handlers = h;
    options = o;
  }, deps);
  return {
    handlers,
    options,
    deps,
    usageLimits,
    advance: () => (now += 60_000),
  };
}

describe("provider-usage.v1 source", () => {
  it("registers a discoverable source and lists only the zcode provider on persistent hosts", async () => {
    const f = fixture();
    expect(f.options.experimental_discoverable).toBe(true);
    const listed = await f.handlers["provider-usage.v1.listResources"](
      {},
      {} as Parameters<Handlers["provider-usage.v1.listResources"]>[1],
    );
    expect(listed).toEqual({
      resources: [
        {
          accountKey: null,
          id: JSON.stringify(["mach", "zcode"]),
          providerId: "zcode",
          label: "ZCode",
          scope: {
            kind: "host",
            hostId: "mach",
            hostName: "Deepol's Mac",
          },
        },
      ],
    });
  });

  it("maps quota windows into the panel grammar and caches a fresh measurement", async () => {
    const f = fixture();
    const id = JSON.stringify(["mach", "zcode"]);
    const first = await f.handlers["provider-usage.v1.getResource"](
      { resourceId: id, refresh: false },
      {} as Parameters<Handlers["provider-usage.v1.getResource"]>[1],
    );
    expect(first).toEqual({
      accountKey: null,
      observedAt: 1_000_000,
      usage: {
        status: "ok",
        accountEmail: null,
        planLabel: "GLM Coding Max",
        windows: [
          {
            kind: "five-hour",
            id: "0:5-hour window",
            label: "5-hour window",
            usedPercent: 8,
            resetsAt: "2026-11-09T19:00:37.483Z",
            model: null,
            cost: null,
          },
          {
            kind: "weekly",
            id: "1:Weekly window",
            label: "Weekly window",
            usedPercent: 23,
            resetsAt: null,
            model: null,
            cost: null,
          },
          {
            kind: "custom",
            id: "2:MCP quota",
            label: "MCP quota",
            usedPercent: 1,
            resetsAt: "2026-12-01T07:48:13.981Z",
            model: null,
            cost: null,
          },
        ],
      },
    });
    expect(
      (
        usageSourceRpcContract["provider-usage.v1.getResource"].output as {
          parse: (v: unknown) => unknown;
        }
      ).parse(first),
    ).toEqual(first);
    // Cached within the TTL: no second collection.
    await f.handlers["provider-usage.v1.getResource"](
      { resourceId: id, refresh: false },
      {} as Parameters<Handlers["provider-usage.v1.getResource"]>[1],
    );
    expect(f.usageLimits).toHaveBeenCalledTimes(1);
    // refresh forces a fresh collection.
    await f.handlers["provider-usage.v1.getResource"](
      { resourceId: id, refresh: true },
      {} as Parameters<Handlers["provider-usage.v1.getResource"]>[1],
    );
    expect(f.usageLimits).toHaveBeenCalledTimes(2);
  });

  it("reports a disconnected host and a failed collection as error usage", async () => {
    const f = fixture();
    const ctx = {} as Parameters<Handlers["provider-usage.v1.getResource"]>[1];
    const disconnected = await f.handlers["provider-usage.v1.getResource"](
      { resourceId: JSON.stringify(["off", "zcode"]), refresh: true },
      ctx,
    );
    expect(record(disconnected).usage).toMatchObject({
      status: "error",
      message: "Machine is disconnected.",
    });
    f.usageLimits.mockImplementation(async () => {
      throw new Error("private-network-canary");
    });
    const failed = await f.handlers["provider-usage.v1.getResource"](
      { resourceId: JSON.stringify(["mach", "zcode"]), refresh: true },
      ctx,
    );
    expect(record(failed).usage).toMatchObject({
      status: "error",
      message: "Usage could not be collected from this machine.",
    });
    expect(JSON.stringify(failed)).not.toContain("canary");
  });

  it("passes non-ok usage states through without inventing windows", async () => {
    const f = fixture({
      usageLimits: vi.fn(
        async () =>
          ({ zcode: { status: "unauthenticated" } }) as Awaited<
            ReturnType<UsageSourceDeps["usageLimits"]>
          >,
      ),
    });
    const reply = await f.handlers["provider-usage.v1.getResource"](
      { resourceId: JSON.stringify(["mach", "zcode"]), refresh: true },
      {} as Parameters<Handlers["provider-usage.v1.getResource"]>[1],
    );
    expect(reply).toEqual({
      accountKey: null,
      observedAt: null,
      usage: { status: "unauthenticated", accountEmail: null, planLabel: null },
    });
  });
});

function record(value: unknown) {
  return value as Record<string, unknown>;
}
