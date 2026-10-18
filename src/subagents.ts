import { z } from "zod";
import { ProtocolError } from "./client.js";

const model = z
  .object({
    providerId: z.string().trim().min(1),
    modelId: z.string().trim().min(1),
    options: z
      .object({ reasoningLevel: z.string().trim().min(1).optional() })
      .strict()
      .optional(),
  })
  .strict();
const profile = z
  .object({
    name: z.string().min(1),
    description: z.string(),
    source: z.enum(["project", "user"]),
    systemPrompt: z.string(),
    path: z.string().optional(),
    modelSelection: model.optional(),
    background: z.boolean().optional(),
    injectAgentsMd: z.boolean().optional(),
    color: z
      .enum([
        "red",
        "blue",
        "green",
        "yellow",
        "purple",
        "orange",
        "pink",
        "cyan",
      ])
      .optional(),
    permissionMode: z
      .enum([
        "acceptEdits",
        "auto",
        "bypassPermissions",
        "default",
        "dontAsk",
        "plan",
      ])
      .optional(),
    memory: z.enum(["user", "project", "local"]).optional(),
    maxTurns: z.number().int().positive().optional(),
    tools: z.array(z.string()).optional(),
    disallowedTools: z.array(z.string()).optional(),
    skills: z.array(z.string()).optional(),
    mcpServers: z.array(z.string()).optional(),
  })
  .strict();
const schema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("ready"),
      profiles: z.array(profile).max(128),
      builtInModelSelectionOverrides: z
        .object({
          Explore: model.optional(),
          "general-purpose": model.optional(),
        })
        .strict(),
      pluginAgentModelSelectionOverrides: z.record(z.string(), model),
    })
    .strict(),
  z.object({ kind: z.literal("built-in-fallback") }).strict(),
]);
export type Subagents = z.infer<typeof schema>;

export function parseSubagents(value: unknown): Subagents | undefined {
  if (value === undefined || value === "") return undefined;
  try {
    const config = schema.parse(
      typeof value === "string" ? JSON.parse(value) : value,
    );
    if (JSON.stringify(config).length > 256 * 1024) throw new Error();
    if (
      config.kind === "ready" &&
      new Set(config.profiles.map((p) => p.name)).size !==
        config.profiles.length
    )
      throw new Error();
    return config;
  } catch {
    throw new ProtocolError(
      "Invalid subagent settings. Use a native ready or built-in-fallback JSON snapshot.",
      -32602,
    );
  }
}
