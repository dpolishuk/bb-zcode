import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { dynamicToolSchema } from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";
import { ProtocolError } from "./client.js";
import { record } from "./protocol.js";

export type BbTool = z.infer<typeof dynamicToolSchema>;
export type ToolResult = {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError: boolean;
};

/** One authenticated loopback MCP endpoint per native session; no child shim. */
export async function createToolServer(
  definitions: BbTool[],
  denied: string[],
  call: (tool: BbTool, args: Record<string, unknown>) => Promise<ToolResult>,
) {
  if (
    definitions.length > 256 ||
    new Set(definitions.map((t) => t.name)).size !== definitions.length
  )
    throw new ProtocolError(
      "Invalid bb tool catalog: too many or duplicate tools.",
      -32602,
    );
  const tools = new Map<string, BbTool>();
  for (const tool of definitions) {
    const alias = `bb_${createHash("sha256").update(tool.name).digest("hex").slice(0, 24)}`;
    if (
      denied.includes(tool.name) ||
      denied.includes(`mcp__bb-bridge__${alias}`)
    )
      continue;
    if (record(tool.inputSchema).type !== "object")
      throw new ProtocolError(
        "A bb tool requires an object input schema.",
        -32602,
      );
    tools.set(alias, tool);
  }
  if (!tools.size) return undefined;
  const token = randomBytes(32).toString("hex");
  let active = true;
  const server = createServer(async (req, res) => {
    res.once("finish", () => {
      if (!active) server.closeIdleConnections();
    });
    if (!active || req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${token}` || req.headers.origin) {
      res.writeHead(401).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let id: unknown = null;
    const reply = (body: unknown) => {
      if (!res.destroyed)
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(body));
    };
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      const message = record(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      id = message.id;
      if (id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const p = record(message.params);
      let result: unknown;
      switch (message.method) {
        case "initialize":
          result = {
            protocolVersion: p.protocolVersion ?? "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "bb-bridge", version: "1" },
          };
          break;
        case "ping":
          result = {};
          break;
        case "tools/list":
          result = {
            tools: [...tools].map(([name, t]) => ({
              name,
              description: `${t.name}: ${t.description}`,
              inputSchema: t.inputSchema,
            })),
          };
          break;
        case "tools/call": {
          const tool = tools.get(String(p.name));
          if (!tool) throw new ProtocolError("Unknown bb tool.", -32602);
          if (
            p.arguments !== undefined &&
            (p.arguments === null ||
              typeof p.arguments !== "object" ||
              Array.isArray(p.arguments))
          )
            throw new ProtocolError(
              "Tool arguments must be an object.",
              -32602,
            );
          result = await call(tool, record(p.arguments));
          break;
        }
        default:
          throw new ProtocolError("Unknown MCP method.", -32601);
      }
      reply({ jsonrpc: "2.0", id, result });
    } catch (error) {
      reply({
        jsonrpc: "2.0",
        id,
        error: {
          code: error instanceof ProtocolError ? error.code : -32603,
          message:
            error instanceof ProtocolError
              ? error.message
              : "bb MCP request failed.",
        },
      });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 100;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Cannot start bb MCP endpoint.");
  return {
    definition: {
      name: "bb-bridge",
      type: "http" as const,
      url: `http://127.0.0.1:${address.port}/mcp`,
      headers: [{ name: "Authorization", value: `Bearer ${token}` }],
      timeoutMs: 10 * 60_000,
    },
    nativeNames: new Set(
      [...tools.keys()].map((name) => `mcp__bb-bridge__${name}`),
    ),
    close() {
      active = false;
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export type ToolServer = Awaited<ReturnType<typeof createToolServer>>;
