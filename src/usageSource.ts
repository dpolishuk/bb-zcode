import type { z } from "zod";
import type {
  BbPluginApi,
  ExperimentalPluginRpcHandlersWithContext,
} from "@get-bb/plugin-sdk";
import { usageSourceRpcContract } from "./usageContract.js";

type UsageResult = z.infer<
  (typeof usageSourceRpcContract)["provider-usage.v1.getResource"]["output"]
>;

/** The sdk surface the usage source needs; injectable for tests. */
export interface UsageSourceDeps {
  hosts: {
    list(): Promise<
      Array<{
        id: string;
        name: string;
        type: string;
        status: string;
      }>
    >;
  };
  providers: {
    list(args: {
      hostId: string;
      capability: "usage";
    }): Promise<Array<{ id: string; pluginId: string; displayName: string }>>;
  };
  usageLimits(args: {
    hostId: string;
    providerId: string;
    refresh: boolean;
  }): Promise<
    Record<
      string,
      | {
          status: "ok";
          accountEmail: string | null;
          planLabel: string | null;
          windows: Array<{
            label: string;
            usedPercent: number;
            resetsAt: string | null;
            cost?: { usedUsdCents: number; limitUsdCents: number } | null;
          }>;
        }
      | {
          status: "not_installed" | "unauthenticated" | "expired" | "error";
          accountEmail?: unknown;
          planLabel?: unknown;
          message?: string;
        }
    >
  >;
  now(): number;
}

export const USAGE_SOURCE_CACHE_MS = 60_000;

/**
 * The panel-facing side of the usage feature: a discoverable
 * provider-usage.v1 source listing the zcode provider on every connected
 * host, with measurements flowing through the daemon's provider/usage path
 * (the bridge's quota fetch) via system.usageLimits. The panel federates
 * only over this contract - a bridge that answers provider/usage alone is
 * invisible to it.
 */
export function registerUsageSource(
  register: (
    handlers: ExperimentalPluginRpcHandlersWithContext<
      typeof usageSourceRpcContract
    >,
    options: {
      experimental_discoverable: boolean;
      experimental_description: string;
    },
  ) => void,
  deps: UsageSourceDeps,
  cacheMs = USAGE_SOURCE_CACHE_MS,
) {
  const cache = new Map<string, UsageResult>();
  // The panel sorts windows by its own grammar; ours map by label.
  const windowKind = (label: string) =>
    label === "5-hour window"
      ? ("five-hour" as const)
      : label === "Weekly window"
        ? ("weekly" as const)
        : ("custom" as const);

  const resourceId = (hostId: string, providerId: string) =>
    JSON.stringify([hostId, providerId]);

  const unavailable = (id: string, message: string): UsageResult => ({
    accountKey: null,
    observedAt: cache.get(id)?.observedAt ?? null,
    usage: {
      status: "error",
      accountEmail: null,
      planLabel: null,
      message,
    },
  });

  register(
    {
      "provider-usage.v1.listResources": async () => {
        const hosts = await deps.hosts.list();
        const resources: Array<{
          accountKey: null;
          id: string;
          providerId: string;
          label: string;
          scope: { kind: "host"; hostId: string; hostName: string };
        }> = [];
        for (const host of hosts.filter((h) => h.type !== "ephemeral")) {
          const providers = await deps.providers
            .list({ hostId: host.id, capability: "usage" })
            .catch(() => []);
          for (const provider of providers) {
            if (provider.pluginId !== "zcode" || provider.id !== "zcode")
              continue;
            resources.push({
              accountKey: null,
              id: resourceId(host.id, provider.id),
              providerId: provider.id,
              label: provider.displayName,
              scope: {
                kind: "host",
                hostId: host.id,
                hostName: host.name,
              },
            });
          }
        }
        const listed = new Set(resources.map((r) => r.id));
        for (const key of cache.keys()) if (!listed.has(key)) cache.delete(key);
        return { resources };
      },
      "provider-usage.v1.getResource": async ({ resourceId: id, refresh }) => {
        let hostId = "";
        let providerId = "";
        try {
          [hostId, providerId] = JSON.parse(id);
        } catch {
          hostId = "";
        }
        const host = (await deps.hosts.list().catch(() => [])).find(
          (h) => h.id === hostId,
        );
        if (!host || host.status !== "connected")
          return unavailable(id, "Machine is disconnected.");
        const cached = cache.get(id);
        if (
          !refresh &&
          cached?.usage.status === "ok" &&
          cached.observedAt !== null &&
          deps.now() - cached.observedAt < cacheMs
        )
          return cached;
        try {
          const limits = await deps.usageLimits({
            hostId,
            providerId,
            refresh,
          });
          const usage = limits[providerId];
          if (!usage) throw new Error("Provider returned no usage.");
          if (usage.status !== "ok") {
            const email =
              typeof usage.accountEmail === "string" &&
              usage.accountEmail !== ""
                ? usage.accountEmail
                : null;
            const label =
              typeof usage.planLabel === "string" && usage.planLabel !== ""
                ? usage.planLabel
                : null;
            const state: UsageResult["usage"] =
              usage.status === "error"
                ? {
                    status: "error",
                    accountEmail: email,
                    planLabel: label,
                    message: usage.message ?? "Usage could not be collected.",
                  }
                : {
                    status: usage.status,
                    accountEmail: email,
                    planLabel: label,
                  };
            return {
              accountKey: null,
              observedAt: cached?.observedAt ?? null,
              usage: state,
            };
          }
          const entry: UsageResult = {
            accountKey: null,
            observedAt: deps.now(),
            usage: {
              ...usage,
              windows: usage.windows.map((w, i) => ({
                kind: windowKind(w.label),
                id: `${i}:${w.label}`,
                label: w.label,
                usedPercent: w.usedPercent,
                resetsAt: w.resetsAt,
                model: null,
                cost: w.cost ?? null,
              })),
            },
          };
          cache.set(id, entry);
          return entry;
        } catch {
          return unavailable(
            id,
            "Usage could not be collected from this machine.",
          );
        }
      },
    },
    {
      experimental_discoverable: true,
      experimental_description:
        "Host-local usage owned by the ZCode provider plugin (Coding Plan quota windows). Inventory reads metadata only. Independent of display plugins.",
    },
  );
}

/** Wire the usage source onto the plugin's rpc area with real sdk deps. */
export function registerPluginUsageSource(bb: BbPluginApi) {
  registerUsageSource(
    (handlers, options) => {
      bb.rpc.register(usageSourceRpcContract, handlers, options);
    },
    {
      hosts: bb.sdk.hosts,
      providers: bb.sdk.providers,
      usageLimits: (args) => bb.sdk.system.usageLimits(args),
      now: () => Date.now(),
    },
  );
}
