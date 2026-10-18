// Deterministic local MCP peer. It records method names, never request payloads.
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (process.env.BB_MCP_FIXTURE_LOG)
    appendFileSync(
      process.env.BB_MCP_FIXTURE_LOG,
      `${JSON.stringify({ method: message.method, pid: process.pid })}\n`,
    );
  if (message.id === undefined) return;
  const result =
    message.method === "initialize"
      ? {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "bb-zcode-fixture", version: "1.0.0" },
        }
      : message.method === "tools/list"
        ? {
            tools: [
              {
                name: "fixture_echo",
                description: "Return a synthetic fixture response.",
                inputSchema: {
                  type: "object",
                  properties: { text: { type: "string" } },
                  required: ["text"],
                },
              },
            ],
          }
        : message.method === "tools/call"
          ? { content: [{ type: "text", text: "Synthetic MCP result." }] }
          : message.method === "resources/list"
            ? { resources: [] }
            : {};
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`,
  );
});
