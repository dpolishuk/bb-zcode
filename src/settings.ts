import { z } from "zod";
import { ProtocolError } from "./client.js";
import { record, RUNTIME_PREFERENCES } from "./protocol.js";
import { parseSubagents } from "./subagents.js";

const entry = z.object({ name: z.string().min(1), value: z.string() });
const common = {
  name: z.string().min(1),
  isolation: z.enum(["session", "workspace"]).optional(),
  timeoutMs: z.number().int().positive().optional(),
  protocolVersion: z.enum(["legacy", "auto", "2026-07-28"]).optional(),
};
const serversSchema = z
  .array(
    z.union([
      z
        .object({
          ...common,
          command: z.string().min(1),
          args: z.array(z.string()).default([]),
          env: z.array(entry).default([]),
        })
        .strict(),
      z
        .object({
          ...common,
          type: z.enum(["http", "sse"]),
          url: z.url(),
          headers: z.array(entry).default([]),
        })
        .strict(),
    ]),
  )
  .max(64);

export function parseMcpServers(value: unknown) {
  try {
    return serversSchema.parse(
      typeof value === "string" ? JSON.parse(value) : (value ?? []),
    );
  } catch {
    throw new ProtocolError(
      "Invalid MCP server settings. Use a JSON array of native stdio, http or sse server definitions.",
      -32602,
    );
  }
}

export function runtimeSettings(raw: unknown) {
  const p = record(raw);
  const subagents = parseSubagents(p.subagents);
  return {
    automationsEnabled: p.automationsEnabled === true,
    bbToolsEnabled: p.bbToolsEnabled === true,
    preferences: {
      ...RUNTIME_PREFERENCES,
      subagentRuntimeConfigEnabled: subagents !== undefined,
      memoryEnabled:
        typeof p.memoryEnabled === "boolean"
          ? p.memoryEnabled
          : RUNTIME_PREFERENCES.memoryEnabled,
      nativeSearchEnhancementsEnabled:
        typeof p.nativeSearchEnhancementsEnabled === "boolean"
          ? p.nativeSearchEnhancementsEnabled
          : RUNTIME_PREFERENCES.nativeSearchEnhancementsEnabled,
    },
    mcpServers: parseMcpServers(p.mcpServers),
    subagents,
  };
}
