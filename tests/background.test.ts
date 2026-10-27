import { expect, it } from "vitest";
import { BackgroundWork } from "../src/lifecycle.js";
import type { ZCodeConnection } from "../src/client.js";
import { record } from "../src/protocol.js";
import {
  threadDeltaNotificationParamsSchema,
  type ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";
const client: ZCodeConnection = {
  async request() {
    return {};
  },
  async close() {},
};
it.each([
  ["pending", undefined, "running"],
  ["running", undefined, "running"],
  ["paused", undefined, "paused"],
  ["completed", "completed", "completed"],
  ["cancelled", "interrupted", "killed"],
  ["timed_out", "failed", "failed"],
  ["spawn_error", "failed", "failed"],
  ["lost", "failed", "failed"],
])(
  "maps native %s task state without fabricating success",
  (state, status, taskStatus) => {
    const deltas: ThreadDelta[] = [];
    const tasks = new BackgroundWork(client, "native", (d) =>
      deltas.push(...d),
    );
    tasks.update({
      backgroundJobs: [
        { taskId: "work", taskKind: "bash", status: state, cancellable: true },
      ],
    });
    expect(tasks.active).toBe(status === undefined);
    const closes = deltas.filter((d) => d.kind === "item.close");
    expect(closes).toHaveLength(status ? 1 : 0);
    if (status) expect(closes[0]!.status).toBe(status);
    expect(record(record(deltas[0]).item).taskStatus).toBe(taskStatus);
    expect(
      threadDeltaNotificationParamsSchema.safeParse({ threadId: "bb", deltas })
        .success,
    ).toBe(true);
    tasks.close("interrupted");
  },
);
it("does not resurrect terminal work from a late running snapshot", () => {
  const deltas: ThreadDelta[] = [];
  const tasks = new BackgroundWork(client, "native", (d) => deltas.push(...d));
  for (const status of ["running", "completed", "running", "completed"])
    tasks.update({
      backgroundJobs: [{ taskId: "work", taskKind: "bash", status }],
    });
  expect(tasks.active).toBe(false);
  expect(deltas.filter((d) => d.kind === "item.open")).toHaveLength(1);
  expect(deltas.filter((d) => d.kind === "item.close")).toHaveLength(1);
  tasks.close("failed");
});
it("preserves running work on partial snapshots that omit the task projection", () => {
  const deltas: ThreadDelta[] = [];
  const tasks = new BackgroundWork(client, "native", (d) => deltas.push(...d));
  tasks.update({
    backgroundJobs: [
      { taskId: "work", taskKind: "subagent", status: "running" },
    ],
  });
  tasks.update({ turnCount: 1 });
  expect(tasks.active).toBe(true);
  expect(deltas.filter((d) => d.kind === "item.close")).toHaveLength(0);
  tasks.close("failed");
  expect(
    deltas.some(
      (d) =>
        d.kind === "item.close" &&
        d.status === "failed" &&
        d.item.type === "delegation",
    ),
  ).toBe(true);
});

/** Journal event fixture shaped like the POC captures (CLI 0.17.0). */
const journalPage = (events: Array<{ type: string; payload: unknown }>) => ({
  events: events.map((event, sequence) => ({
    sequence,
    type: event.type,
    payload: event.payload,
  })),
  hasMore: false,
});
it("renders a dynamic-workflow run as a local_workflow task with agent lamps", async () => {
  const deltas: ThreadDelta[] = [];
  let events = journalPage([
    {
      type: "run-launched",
      payload: { phaseNames: ["first", "second"] },
    },
    {
      type: "actor-created",
      payload: {
        actor: { siteId: "actor#1" },
        name: "one",
        phaseName: "first",
      },
    },
    {
      type: "node-dispatched",
      payload: { instance: { siteId: "ask#1" }, actor: { siteId: "actor#1" } },
    },
    { type: "node-executing", payload: { instance: { siteId: "ask#1" } } },
  ]);
  const wire: ZCodeConnection = {
    async request(method: string) {
      if (method === "v4/conversation/workflowRunEvents") return events;
      if (method === "session/read")
        return {
          projection: {
            backgroundJobs: [
              {
                taskId: "dwfrun-1",
                toolName: "CreateWorkflow",
                taskKind: "workflow",
                status: "running",
                cancellable: true,
              },
            ],
          },
        };
      return {};
    },
    async close() {},
  };
  const tasks = new BackgroundWork(
    wire,
    "native",
    (d) => deltas.push(...d),
    () => "glm-5.3",
  );
  // First projection opens the run-level row before any journal pull.
  tasks.update({
    backgroundJobs: [
      { taskId: "dwfrun-1", taskKind: "workflow", status: "running" },
    ],
  });
  const opened = record(record(deltas[0]).item);
  expect(opened.taskType).toBe("local_workflow");
  expect(opened.workflow).toBeUndefined();
  // The next refresh folds the journal into the live agent lamps.
  await tasks.refresh();
  const progress = deltas.find((d) => d.kind === "item.progress");
  const snapshot = record(record(record(progress).snapshot).workflow);
  expect(snapshot.phases).toEqual([
    { index: 1, title: "first" },
    { index: 2, title: "second" },
  ]);
  const agent = record((snapshot.agents as unknown[])[0]);
  expect(agent.label).toBe("one");
  expect(agent.state).toBe("running");
  expect(agent.model).toBe("glm-5.3");
  expect(agent.phaseTitle).toBe("first");
  expect(agent.phaseIndex).toBe(1);
  expect(
    threadDeltaNotificationParamsSchema.safeParse({ threadId: "bb", deltas })
      .success,
  ).toBe(true);
  // Terminal journal + registry row close the row with an honest summary.
  events = journalPage([
    {
      type: "node-settled",
      payload: { instance: { siteId: "ask#1" }, outcome: "ok" },
    },
    { type: "usage-updated", payload: { spentTokens: 34 } },
    { type: "run-settled", payload: { status: "completed" } },
  ]);
  wire.request = async (method: string) => {
    if (method === "v4/conversation/workflowRunEvents") return events;
    if (method === "session/read")
      return {
        projection: {
          backgroundJobs: [
            {
              taskId: "dwfrun-1",
              taskKind: "workflow",
              status: "completed",
              cancellable: false,
            },
          ],
        },
      };
    return {};
  };
  await tasks.refresh();
  const closed = deltas.find((d) => d.kind === "item.close");
  expect(closed?.status).toBe("completed");
  const closedItem = record(record(closed).item);
  expect(closedItem.taskType).toBe("local_workflow");
  expect(closedItem.summary).toBe("completed · 34 tokens");
  expect(
    record((record(closedItem.workflow).agents as unknown[])[0]).state,
  ).toBe("done");
  expect(tasks.active).toBe(false);
});
it("reactivates an agent lamp when its actor runs a subsequent node", async () => {
  const deltas: ThreadDelta[] = [];
  let events = journalPage([
    {
      type: "actor-created",
      payload: { actor: { siteId: "actor#1" }, name: "one" },
    },
    {
      type: "node-dispatched",
      payload: { instance: { siteId: "ask#1" }, actor: { siteId: "actor#1" } },
    },
    {
      type: "node-settled",
      payload: { instance: { siteId: "ask#1" }, outcome: "ok" },
    },
  ]);
  const wire: ZCodeConnection = {
    async request(method: string) {
      if (method === "v4/conversation/workflowRunEvents") return events;
      if (method === "session/read")
        return {
          projection: {
            backgroundJobs: [
              { taskId: "dwfrun-3", taskKind: "workflow", status: "running" },
            ],
          },
        };
      return {};
    },
    async close() {},
  };
  const tasks = new BackgroundWork(
    wire,
    "native",
    (d) => deltas.push(...d),
    () => "glm-5.3",
  );
  tasks.update({
    backgroundJobs: [
      { taskId: "dwfrun-3", taskKind: "workflow", status: "running" },
    ],
  });
  const agentState = () => {
    const progress = [...deltas]
      .reverse()
      .find((d) => d.kind === "item.progress");
    const snapshot = record(record(record(progress).snapshot).workflow);
    return record((snapshot.agents as unknown[])[0]).state;
  };
  // The first node settles; the actor immediately gets a second ask.
  await tasks.refresh();
  expect(agentState()).toBe("done");
  events = journalPage([
    {
      type: "node-dispatched",
      payload: { instance: { siteId: "ask#2" }, actor: { siteId: "actor#1" } },
    },
    { type: "node-executing", payload: { instance: { siteId: "ask#2" } } },
  ]);
  await tasks.refresh();
  expect(agentState()).toBe("running");
  events = journalPage([
    {
      type: "node-settled",
      payload: { instance: { siteId: "ask#2" }, outcome: "failed" },
    },
  ]);
  await tasks.refresh();
  expect(agentState()).toBe("failed");
});
it("drains every journal page before the settled run closes the row", async () => {
  const deltas: ThreadDelta[] = [];
  const calls: Array<Record<string, unknown>> = [];
  // Page 1 leaves the actor mid-run and the journal continued.
  const page1 = {
    events: [
      {
        sequence: 0,
        type: "actor-created",
        payload: { actor: { siteId: "actor#1" }, name: "one" },
      },
      {
        sequence: 1,
        type: "node-dispatched",
        payload: {
          instance: { siteId: "ask#1" },
          actor: { siteId: "actor#1" },
        },
      },
    ],
    hasMore: true,
  };
  // Page 2 carries the final usage and settlement.
  const page2 = {
    events: [
      {
        sequence: 2,
        type: "node-settled",
        payload: { instance: { siteId: "ask#1" }, outcome: "ok" },
      },
      { sequence: 3, type: "usage-updated", payload: { spentTokens: 34 } },
      { sequence: 4, type: "run-settled", payload: { status: "completed" } },
    ],
    hasMore: false,
  };
  const pages = [page1, page2];
  const wire: ZCodeConnection = {
    async request(method: string, params?: unknown) {
      if (method === "v4/conversation/workflowRunEvents") {
        calls.push(record(params));
        return pages.shift() ?? { events: [], hasMore: false };
      }
      if (method === "session/read")
        return {
          projection: {
            backgroundJobs: [
              { taskId: "dwfrun-4", taskKind: "workflow", status: "completed" },
            ],
          },
        };
      return {};
    },
    async close() {},
  };
  const tasks = new BackgroundWork(
    wire,
    "native",
    (d) => deltas.push(...d),
    () => "glm-5.3",
  );
  tasks.update({
    backgroundJobs: [
      { taskId: "dwfrun-4", taskKind: "workflow", status: "running" },
    ],
  });
  await tasks.refresh();
  // Both pages were pulled in one refresh before the close froze the fold.
  expect(calls).toHaveLength(2);
  expect(calls[1]).toMatchObject({ afterSequence: 1 });
  const closed = deltas.find((d) => d.kind === "item.close");
  expect(closed?.status).toBe("completed");
  expect(record(record(closed).item).summary).toBe("completed · 34 tokens");
});
it("keeps fan-out instances apart when references share a siteId", async () => {
  const deltas: ThreadDelta[] = [];
  const events = journalPage([
    {
      type: "actor-created",
      payload: {
        actor: { siteId: "actor#1", ordinal: 0 },
        name: "first",
      },
    },
    {
      type: "actor-created",
      payload: {
        actor: { siteId: "actor#1", ordinal: 1 },
        name: "second",
      },
    },
    {
      type: "node-dispatched",
      payload: {
        instance: { siteId: "ask#1", ordinal: 0 },
        actor: { siteId: "actor#1", ordinal: 0 },
      },
    },
    {
      type: "node-dispatched",
      payload: {
        instance: { siteId: "ask#1", ordinal: 1 },
        actor: { siteId: "actor#1", ordinal: 1 },
      },
    },
    {
      type: "node-settled",
      payload: { instance: { siteId: "ask#1", ordinal: 0 }, outcome: "ok" },
    },
  ]);
  const wire: ZCodeConnection = {
    async request(method: string) {
      if (method === "v4/conversation/workflowRunEvents") return events;
      if (method === "session/read")
        return {
          projection: {
            backgroundJobs: [
              { taskId: "dwfrun-5", taskKind: "workflow", status: "running" },
            ],
          },
        };
      return {};
    },
    async close() {},
  };
  const tasks = new BackgroundWork(
    wire,
    "native",
    (d) => deltas.push(...d),
    () => "glm-5.3",
  );
  tasks.update({
    backgroundJobs: [
      { taskId: "dwfrun-5", taskKind: "workflow", status: "running" },
    ],
  });
  await tasks.refresh();
  const progress = [...deltas]
    .reverse()
    .find((d) => d.kind === "item.progress");
  const agents = record(record(record(progress).snapshot).workflow)
    .agents as unknown[];
  const byLabel = new Map(
    agents.map((agent) => [record(agent).label, record(agent).state]),
  );
  // Same siteId, different ordinals: two distinct actors and nodes.
  expect(byLabel.get("first")).toBe("done");
  expect(byLabel.get("second")).toBe("running");
});
it("hydrates a run discovered after settlement before closing its row", async () => {
  const deltas: ThreadDelta[] = [];
  const events = journalPage([
    {
      type: "actor-created",
      payload: { actor: { siteId: "actor#9" }, name: "late" },
    },
    {
      type: "node-dispatched",
      payload: { instance: { siteId: "ask#9" }, actor: { siteId: "actor#9" } },
    },
    {
      type: "node-settled",
      payload: { instance: { siteId: "ask#9" }, outcome: "ok" },
    },
    { type: "usage-updated", payload: { spentTokens: 34 } },
    { type: "run-settled", payload: { status: "completed" } },
  ]);
  const wire: ZCodeConnection = {
    async request(method: string) {
      if (method === "v4/conversation/workflowRunEvents") return events;
      if (method === "session/read")
        return {
          projection: {
            backgroundJobs: [
              { taskId: "dwfrun-6", taskKind: "workflow", status: "completed" },
            ],
          },
        };
      return {};
    },
    async close() {},
  };
  const tasks = new BackgroundWork(
    wire,
    "native",
    (d) => deltas.push(...d),
    () => "glm-5.3",
  );
  // The run is already terminal at first sight: the row opens but must not
  // close on an empty fold.
  tasks.update({
    backgroundJobs: [
      { taskId: "dwfrun-6", taskKind: "workflow", status: "completed" },
    ],
  });
  expect(deltas.some((d) => d.kind === "item.close")).toBe(false);
  expect(tasks.active).toBe(true);
  await tasks.refresh();
  const closed = deltas.find((d) => d.kind === "item.close");
  expect(closed?.status).toBe("completed");
  expect(record(record(closed).item).summary).toBe("completed · 34 tokens");
  expect(
    record(
      (record(record(record(closed).item).workflow).agents as unknown[])[0],
    ).state,
  ).toBe("done");
});
it("waits for the journal when the projection reports completion first", async () => {
  const deltas: ThreadDelta[] = [];
  // Refresh 1 folds a mid-run page; the run settles right after the pull.
  const midRun = journalPage([
    {
      type: "actor-created",
      payload: { actor: { siteId: "actor#2" }, name: "racer" },
    },
    {
      type: "node-dispatched",
      payload: { instance: { siteId: "ask#2" }, actor: { siteId: "actor#2" } },
    },
    { type: "node-executing", payload: { instance: { siteId: "ask#2" } } },
  ]);
  // Refresh 2 catches the terminal page the race skipped.
  const terminal = journalPage([
    {
      type: "node-settled",
      payload: { instance: { siteId: "ask#2" }, outcome: "ok" },
    },
    { type: "usage-updated", payload: { spentTokens: 34 } },
    { type: "run-settled", payload: { status: "completed" } },
  ]);
  const pages = [midRun, terminal];
  const wire: ZCodeConnection = {
    async request(method: string) {
      if (method === "v4/conversation/workflowRunEvents")
        return pages.shift() ?? { events: [], hasMore: false };
      if (method === "session/read")
        return {
          projection: {
            backgroundJobs: [
              { taskId: "dwfrun-7", taskKind: "workflow", status: "completed" },
            ],
          },
        };
      return {};
    },
    async close() {},
  };
  const tasks = new BackgroundWork(
    wire,
    "native",
    (d) => deltas.push(...d),
    () => "glm-5.3",
  );
  tasks.update({
    backgroundJobs: [
      { taskId: "dwfrun-7", taskKind: "workflow", status: "running" },
    ],
  });
  // The projection turns terminal before the journal fold caught up: the
  // row must stay open instead of closing on stale running lamps.
  await tasks.refresh();
  expect(deltas.some((d) => d.kind === "item.close")).toBe(false);
  expect(tasks.active).toBe(true);
  await tasks.refresh();
  const closed = deltas.find((d) => d.kind === "item.close");
  expect(closed?.status).toBe("completed");
  expect(record(record(closed).item).summary).toBe("completed · 34 tokens");
});
it("keeps the workflow row honest when the journal surface is unavailable", async () => {
  const deltas: ThreadDelta[] = [];
  const wire: ZCodeConnection = {
    async request(method: string) {
      if (method === "v4/conversation/workflowRunEvents")
        throw new Error("unsupported");
      if (method === "session/read")
        return {
          projection: {
            backgroundJobs: [
              { taskId: "dwfrun-2", taskKind: "workflow", status: "running" },
            ],
          },
        };
      return {};
    },
    async close() {},
  };
  const tasks = new BackgroundWork(wire, "native", (d) => deltas.push(...d));
  tasks.update({
    backgroundJobs: [
      { taskId: "dwfrun-2", taskKind: "workflow", status: "running" },
    ],
  });
  await tasks.refresh();
  const items = deltas.map((d) => record(d).item).filter(Boolean);
  for (const item of items)
    expect(record(item).taskType).toBe("local_workflow");
  expect(items.every((item) => record(item).workflow === undefined)).toBe(true);
  expect(tasks.active).toBe(true);
  tasks.close("interrupted");
});
