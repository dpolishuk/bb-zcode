import type { BbPluginApi } from "@get-bb/plugin-sdk";
export default function plugin(bb: BbPluginApi) {
  bb.agents.registerTool({
    name: "ZCodeFixtureEcho",
    description: "fixture.echo: deterministic installed bb tool",
    parameters: { type: "object", properties: { text: { type: "string" } } },
    presentation: {
      label: { pending: "Echoing", completed: "Echo" },
      icon: { glyph: "Terminal" },
    },
    execute() {
      return "BB_INSTALLED_TOOL_RESULT";
    },
  });
  bb.agents.configure(() => ({
    tools: ["ZCodeFixtureEcho"],
    skills: ["fixture-installed-skill"],
  }));
}
