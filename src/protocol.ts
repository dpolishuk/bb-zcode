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
  const entry = snapshot.settings.model.available.find(
    (m) =>
      m.ref.providerId === selection.providerId &&
      m.ref.modelId === selection.modelId,
  );
  const levels = entry?.reasoning?.levels ?? [];
  const current = snapshot.settings.model.current;
  const options = {
    ...record(record(entry?.ref).options),
    ...(current?.providerId === selection.providerId &&
    current?.modelId === selection.modelId
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
    modelId: selection.modelId,
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
