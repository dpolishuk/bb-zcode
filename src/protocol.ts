import { z } from "zod";

export const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const text = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;
export const modelRefSchema = z
  .object({ providerId: z.string().min(1), modelId: z.string().min(1) })
  .passthrough();
export const snapshotSchema = z
  .object({
    session: z.object({ sessionId: z.string().min(1) }).passthrough(),
    settings: z
      .object({
        model: z
          .object({
            current: modelRefSchema.optional(),
            available: z.array(
              z
                .object({
                  ref: modelRefSchema,
                  label: z.string(),
                  description: z.string().optional(),
                  contextWindow: z.number().optional(),
                  disabledReason: z.string().optional(),
                  reasoning: z
                    .object({
                      levels: z.array(
                        z.object({
                          value: z.string(),
                          label: z.string(),
                          description: z.string().optional(),
                        }),
                      ),
                      defaultLevel: z.string().optional(),
                    })
                    .optional(),
                })
                .passthrough(),
            ),
          })
          .passthrough(),
      })
      .passthrough(),
    projection: z
      .object({ turnCount: z.number().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type Snapshot = z.infer<typeof snapshotSchema>;

export function modelForTurn(
  snapshot: Snapshot,
  model: string | undefined,
  reasoning?: string,
) {
  const selection = selectedModel(model) ?? snapshot.settings.model.current;
  if (!selection) return undefined;
  // Only catalog budget aliases resolve to a base native model.
  const nativeModelId = baseModelId(snapshot, selection);
  const entry = snapshot.settings.model.available.find(
    (m) =>
      m.ref.providerId === selection.providerId &&
      m.ref.modelId === nativeModelId,
  );
  const levels = entry?.reasoning?.levels ?? [];
  const current = snapshot.settings.model.current;
  const options = {
    ...record(record(entry?.ref).options),
    ...(current?.providerId === selection.providerId &&
    current?.modelId === nativeModelId
      ? record(record(current).options)
      : {}),
    ...record(record(selection).options),
  };
  const saved = text(options.reasoningLevel);
  const level = levels.some((l) => l.value === reasoning)
    ? reasoning
    : levels.some((l) => l.value === saved)
      ? saved
      : (entry?.reasoning?.defaultLevel ?? levels[0]?.value);
  return {
    providerId: selection.providerId,
    modelId: nativeModelId,
    ...(Object.keys(options).length || level
      ? { options: { ...options, ...(level ? { reasoningLevel: level } : {}) } }
      : {}),
  };
}
export const eventSchema = z
  .object({
    sessionId: z.string(),
    type: z.string(),
    eventSeq: z.number().optional(),
    seq: z.number().optional(),
    turnId: z.string().optional(),
    payload: z.unknown().optional(),
  })
  .passthrough();

/**
 * A model's advertised context window, e.g. GLM-5.3's 1,000,000 tokens. The
 * native session projection keeps its pre-bind default (200000) even after a
 * model is bound, so usage reporting must read the window from model
 * metadata instead of trusting the projection.
 */
export function modelContextWindow(
  snapshot: Snapshot,
  selection?: { providerId: string; modelId: string },
): number | undefined {
  const target = selection ?? snapshot.settings.model.current;
  if (!target) return undefined;
  const variant = contextBudgetVariant(snapshot, target);
  const entry = snapshot.settings.model.available.find(
    (m) =>
      m.ref.providerId === target.providerId &&
      m.ref.modelId === (variant?.base.modelId ?? target.modelId),
  );
  const window = entry?.contextWindow;
  const valid =
    typeof window === "number" && Number.isFinite(window) && window > 0
      ? window
      : undefined;
  // A budget variant can only shrink the window it reports to bb.
  if (variant && valid) return Math.min(variant.window, valid);
  if (variant) return undefined;
  return valid;
}

export function formatContextWindow(window: number): string {
  if (window >= 1_000_000 && window % 1_000_000 === 0)
    return `${window / 1_000_000}M`;
  if (window >= 1_000) return `${Math.round(window / 1_000)}K`;
  return `${window}`;
}

/**
 * Plugin-side context-budget variants: bb selector entries that run the base
 * native model but cap the window reported to bb. The native registry has no
 * separate model ids for smaller windows (it rejects `GLM-5.3-256K`), so the
 * variant exists only in the id suffix and in context reporting.
 */
export const CONTEXT_BUDGET_VARIANTS = [
  { suffix: "-256k", window: 256_000 },
] as const;

type ModelIdentity = { providerId: string; modelId: string };
const modelIdentityKey = (model: ModelIdentity) =>
  JSON.stringify([model.providerId, model.modelId]);

/** Allocate one shared, provider-scoped alias table for listing and dispatch. */
export function contextBudgetVariants(snapshot: Snapshot) {
  const models = [...snapshot.settings.model.available].sort((a, b) => {
    const left = modelIdentityKey(a.ref),
      right = modelIdentityKey(b.ref);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  // Reserve disabled native entries and the saved native current selection too:
  // an alias must never steal a real identity, even if it is not selectable now.
  const reserved = new Set(models.map((model) => modelIdentityKey(model.ref)));
  const current = snapshot.settings.model.current;
  if (current) reserved.add(modelIdentityKey(current));
  const variants: Array<{
    ref: ModelIdentity;
    base: ModelIdentity;
    window: number;
  }> = [];
  for (const model of models) {
    for (const budget of CONTEXT_BUDGET_VARIANTS) {
      let modelId = `${model.ref.modelId}${budget.suffix}`;
      const occupied = (id: string) =>
        reserved.has(
          modelIdentityKey({ providerId: model.ref.providerId, modelId: id }),
        );
      if (occupied(modelId)) {
        const fallback = `${model.ref.modelId}-bb-context${budget.suffix}`;
        modelId = fallback;
        for (let index = 2; occupied(modelId); index++)
          modelId = `${fallback}-${index}`;
      }
      const ref = { providerId: model.ref.providerId, modelId };
      reserved.add(modelIdentityKey(ref));
      variants.push({ ref, base: model.ref, window: budget.window });
    }
  }
  // Keep resolution for saved budgets when metadata shrinks or is missing.
  // The selector advertises only budgets smaller than the native window.
  return variants;
}

function contextBudgetVariant(snapshot: Snapshot, selection: ModelIdentity) {
  return contextBudgetVariants(snapshot).find(
    (variant) =>
      variant.ref.providerId === selection.providerId &&
      variant.ref.modelId === selection.modelId,
  );
}

export function baseModelId(
  snapshot: Snapshot,
  selection: ModelIdentity,
): string {
  return (
    contextBudgetVariant(snapshot, selection)?.base.modelId ?? selection.modelId
  );
}

export function selectedModel(model: string | undefined, reasoning?: string) {
  if (!model || model === "zcode-default") return undefined;
  const split = model.indexOf("/");
  if (split < 1 || split === model.length - 1)
    throw new Error("ZCode models must use providerId/modelId.");
  return {
    providerId: model.slice(0, split),
    modelId: model.slice(split + 1),
    ...(reasoning ? { options: { reasoningLevel: reasoning } } : {}),
  };
}

export const DEFAULT_MODEL = {
  id: "zcode-default",
  model: "zcode-default",
  displayName: "ZCode models unavailable",
  isDefault: true,
  description:
    "Open ZCode on this machine, check the selected provider, then refresh the model list.",
  supportedReasoningEfforts: [
    { reasoningEffort: "none", description: "Use ZCode model defaults." },
  ],
  defaultReasoningEffort: "none",
};
export const RUNTIME_PREFERENCES = {
  nativeSearchEnhancementsEnabled: false,
  subagentRuntimeConfigEnabled: false,
  memoryEnabled: false,
  askUserQuestionAutoResolutionEnabled: false,
};
