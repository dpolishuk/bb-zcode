import { expect, it } from "vitest";
import { History } from "../src/lifecycle.js";
import { record } from "../src/protocol.js";
import type { ZCodeConnection } from "../src/client.js";
const row = {
  kind: "assistantText",
  rowId: 4,
  entityId: "message",
  turnId: "turn",
  text: "stable answer",
  state: "complete",
  actions: { canFork: true },
};
const range = {
  rows: [row],
  atSeq: 10,
  atRevision: 7,
  atLogEpoch: "epoch",
  hasMore: false,
};
function peer(
  handle: (method: string, params: Record<string, unknown>) => unknown,
) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const client: ZCodeConnection = {
    async request(method, raw) {
      const params = record(raw);
      calls.push({ method, params });
      return handle(method, params);
    },
    async close() {},
  };
  return { history: new History(client, "source"), calls };
}
it.each(["stale", "rejected", "failed", "noop"])(
  "rejects a %s native fork acknowledgement without retry",
  async (status) => {
    const p = peer((method, args) =>
      method === "v4/conversation/rowsRange"
        ? range
        : {
            commandId: args.commandId,
            status,
            reasonCode: "fixture.rejected",
            revisionAtDecision: 7,
          },
    );
    await expect(p.history.fork()).rejects.toThrow(status);
    expect(p.calls.filter((c) => c.method === "v4/command")).toHaveLength(1);
  },
);
it.each([
  {
    commandId: "wrong",
    status: "accepted",
    result: { type: "forkAssistant", sessionId: "child" },
  },
  {
    status: "accepted",
    result: { type: "forkAssistant", sessionId: "source" },
  },
  { status: "accepted", result: { type: "wrong", sessionId: "child" } },
])("rejects invalid fork result %j", async (ack) => {
  const p = peer((method, args) =>
    method === "v4/conversation/rowsRange"
      ? range
      : { commandId: args.commandId, ...ack },
  );
  await expect(p.history.fork()).rejects.toThrow();
});
it("rejects a re-materialized checkpoint whose stable content changed", async () => {
  const p = peer(() => ({
    ...range,
    atLogEpoch: "new",
    rows: [{ ...row, rowId: 20, text: "changed answer" }],
  }));
  await expect(p.history.target(p.history.encode(range, row))).rejects.toThrow(
    "content changed",
  );
  expect(p.calls.every((c) => c.method !== "v4/command")).toBe(true);
});
it("pages to the exact historical entity and uses that read's CAS watermarks", async () => {
  const p = peer((_method, args) =>
    args.beforeRowId
      ? { ...range, rows: [row] }
      : {
          ...range,
          rows: [{ ...row, rowId: 400, entityId: "newer" }],
          hasMore: true,
        },
  );
  const result = await p.history.target(p.history.encode(range, row));
  expect(result.row.entityId).toBe("message");
  expect(p.calls[1]!.params.beforeRowId).toBe(400);
});
it("rejects history revision drift between pages", async () => {
  const p = peer((_method, args) =>
    args.beforeRowId
      ? { ...range, atRevision: 8 }
      : {
          ...range,
          rows: [{ ...row, rowId: 400, entityId: "newer" }],
          hasMore: true,
        },
  );
  await expect(p.history.target(p.history.encode(range, row))).rejects.toThrow(
    "history changed",
  );
});
it("rejects a tip with newer unfinished turn rows", async () => {
  const p = peer(() => ({
    ...range,
    rows: [row, { kind: "turnHeader", rowId: 10, turnId: "active" }],
  }));
  await expect(p.history.fork()).rejects.toThrow(
    "No stable assistant checkpoint",
  );
});
it("does not authorize file apply when native preview reports conflicts", async () => {
  const header = {
    kind: "turnHeader",
    rowId: 1,
    entityId: "header",
    turnId: "turn",
    actions: { canRewindFiles: true },
  };
  const p = peer((method) =>
    method === "v4/conversation/rowsRange"
      ? { ...range, rows: [header, row] }
      : {
          canApply: false,
          safeFiles: [],
          unsafeFiles: [{ path: "fixture.txt", reason: "external_modified" }],
          ignoredFiles: [],
        },
  );
  expect(await p.history.previewFiles()).toContain("external_modified");
  await expect(p.history.rewindFiles("anything")).rejects.toThrow("preview");
  expect(p.calls.some((c) => c.method === "v4/command")).toBe(false);
});
it("invalidates a file preview when native history changes before apply", async () => {
  let revision = 7;
  const header = {
    kind: "turnHeader",
    rowId: 1,
    entityId: "header",
    turnId: "turn",
    actions: { canRewindFiles: true },
  };
  const p = peer((method) =>
    method === "v4/conversation/rowsRange"
      ? { ...range, atRevision: revision, rows: [header, row] }
      : { canApply: true, safeFiles: [], unsafeFiles: [], ignoredFiles: [] },
  );
  const output = await p.history.previewFiles();
  const id = output.match(/preview-[a-f0-9-]+/)![0];
  revision = 8;
  await expect(p.history.rewindFiles(id)).rejects.toThrow("History changed");
  expect(p.calls.some((c) => c.method === "v4/command")).toBe(false);
});
