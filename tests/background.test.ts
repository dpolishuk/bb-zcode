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
