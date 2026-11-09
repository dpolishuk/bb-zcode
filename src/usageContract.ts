import { z } from "zod";

/**
 * The wire contract of bb's federated "Provider usage" panel. The panel
 * discovers usage sources through experimental RPC discovery of
 * `provider-usage.v1.listResources` and reads each resource with
 * `provider-usage.v1.getResource`; builtin provider plugins (codex,
 * claude-code, acp) implement the same two methods server-side. This is not
 * part of the plugin SDK - matching the builtin wire is the integration.
 *
 * Pure zod: nothing here touches node-only APIs.
 */

const accountKeySchema = z
  .string()
  .min(1)
  .nullable()
  .describe(
    "Provider-issued quota account identity. Null means unknown; unknown accounts must not be merged.",
  );

const usageWindowSchema = z.object({
  kind: z.enum(["five-hour", "daily", "weekly", "custom"]),
  id: z.string().min(1),
  label: z.string().min(1),
  usedPercent: z
    .number()
    .nonnegative()
    .describe("Percentage consumed; may exceed 100 for overage."),
  resetsAt: z
    .string()
    .nullable()
    .describe("ISO timestamp, or null when no reset is known."),
  model: z
    .string()
    .nullable()
    .describe("Applicable model family, or null for all models."),
  cost: z
    .object({
      usedUsdCents: z.number().nonnegative(),
      limitUsdCents: z.number().positive(),
    })
    .nullable(),
});

const usageStateSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    accountEmail: z.string().nullable(),
    planLabel: z.string().nullable(),
    windows: z.array(usageWindowSchema),
  }),
  z.object({
    status: z.literal("not_installed"),
    accountEmail: z.string().nullable(),
    planLabel: z.string().nullable(),
  }),
  z.object({
    status: z.literal("unauthenticated"),
    accountEmail: z.string().nullable(),
    planLabel: z.string().nullable(),
  }),
  z.object({
    status: z.literal("expired"),
    accountEmail: z.string().nullable(),
    planLabel: z.string().nullable(),
  }),
  z.object({
    status: z.literal("error"),
    accountEmail: z.string().nullable(),
    planLabel: z.string().nullable(),
    message: z.string(),
  }),
]);

const usageResourceSchema = z.object({
  accountKey: accountKeySchema,
  id: z
    .string()
    .min(1)
    .describe("Stable resource ID within this source plugin."),
  providerId: z.string().min(1),
  label: z.string().min(1),
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("shared") }),
    z.object({
      kind: z.literal("host"),
      hostId: z.string().min(1),
      hostName: z.string().min(1),
    }),
  ]),
});

export const usageSourceRpcContract = {
  "provider-usage.v1.listResources": {
    input: z.object({}).strict(),
    output: z.object({
      label: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Declares a shared group even when empty. Host-only sources omit it; machine groups use host names.",
        ),
      resources: z.array(usageResourceSchema),
    }),
  },
  "provider-usage.v1.getResource": {
    input: z
      .object({
        resourceId: z.string().min(1),
        refresh: z
          .boolean()
          .describe(
            "False permits a cached measurement but still returns actual usage. True requests a fresh collection attempt for this resource only.",
          ),
      })
      .strict(),
    output: z.object({
      accountKey: accountKeySchema,
      observedAt: z
        .number()
        .int()
        .nonnegative()
        .nullable()
        .describe(
          "Last successful measurement time in epoch milliseconds; null if never observed.",
        ),
      usage: usageStateSchema,
    }),
  },
} as const;
