import { expect, it } from "vitest";
import { parseMcpServers } from "../src/settings.js";

it("normalizes stdio and HTTP MCP definitions into the native startup contract", () => {
  expect(
    parseMcpServers(
      JSON.stringify([
        { name: "local", command: "/node", args: ["server.js"] },
        { name: "remote", type: "http", url: "https://example.com/mcp" },
      ]),
    ),
  ).toEqual([
    { name: "local", command: "/node", args: ["server.js"], env: [] },
    {
      name: "remote",
      type: "http",
      url: "https://example.com/mcp",
      headers: [],
    },
  ]);
});

it("rejects malformed MCP configuration without echoing header or environment values", () => {
  for (const value of [
    '{"secret":"PRIVATE_MCP_CANARY"}',
    '[{"name":"x","type":"invalid","headers":[{"name":"Authorization","value":"PRIVATE_MCP_CANARY"}]}]',
  ]) {
    let error = "";
    try {
      parseMcpServers(value);
    } catch (e) {
      error = String(e);
    }
    expect(error).toContain("Invalid MCP server settings");
    expect(error).not.toContain("PRIVATE_MCP_CANARY");
  }
});
