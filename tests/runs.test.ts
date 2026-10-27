import { expect, it } from "vitest";
import {
  readWorkflowRunsFrom,
  runRowView,
  WorkflowRunsReader,
} from "../src/runs.js";
import type { ZCodeConnection } from "../src/client.js";
import { record } from "../src/protocol.js";

const reply = (runs: unknown[], truncated = false) => ({ runs, truncated });

it("parses run rows from the cold store read and always closes the client", async () => {
  let closed = false;
  const requests: string[] = [];
  const wire: ZCodeConnection = {
    async request(method) {
      requests.push(method);
      return reply([
        {
          runId: "dwfrun-a",
          status: "completed",
          spentTokens: 34,
          parentSessionId: "sess-1",
          toolCallId: "call-1",
          createdAt: 1,
          updatedAt: 2,
          name: "two-phase",
          cwd: "/w",
          artifacts: [
            { id: "art", kind: "metrics", title: "Board", version: 3 },
          ],
        },
        { runId: "dwfrun-b", status: "running" },
      ]);
    },
    async close() {
      closed = true;
    },
  };
  const snapshot = await readWorkflowRunsFrom(() => wire, "/w", 10);
  expect(requests).toEqual(["workflows/runs"]);
  expect(closed).toBe(true);
  expect(snapshot.runs).toHaveLength(2);
  expect(snapshot.runs[0]).toMatchObject({
    runId: "dwfrun-a",
    status: "completed",
    spentTokens: 34,
    parentSessionId: "sess-1",
  });
  const view = runRowView(snapshot.runs[0]!);
  expect(view.name).toBe("two-phase");
  expect(record(view.artifacts![0])).toMatchObject({
    id: "art",
    kind: "metrics",
    title: "Board",
  });
  expect(runRowView(snapshot.runs[1]!).parentSessionId).toBeUndefined();
});

it("rejects malformed run rows instead of inventing history", async () => {
  const wire: ZCodeConnection = {
    async request() {
      return reply([{ runId: "dwfrun-x", status: "nonsense" }]);
    },
    async close() {},
  };
  await expect(readWorkflowRunsFrom(() => wire, "/w")).rejects.toThrow();
});

it("shares one spawn per TTL window across concurrent readers", async () => {
  let spawns = 0;
  const reader = new WorkflowRunsReader(async () => {
    spawns++;
    return {
      runs: [{ runId: "dwfrun-c", status: "running" as const }],
      truncated: false,
    };
  });
  const [a, b] = await Promise.all([reader.read("/w"), reader.read("/w")]);
  expect(spawns).toBe(1);
  expect(a).toEqual(b);
  await reader.read("/w");
  expect(spawns).toBe(1);
  await reader.read("/w", 50, true);
  expect(spawns).toBe(2);
});
