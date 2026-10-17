import { resolve } from "node:path";
import { expect, it } from "vitest";
import { ZCodeClient } from "../src/client.js";

function client(mode: string) {
  return new ZCodeClient(
    {
      command: process.execPath,
      args: [resolve("tests/fixtures/transport-peer.mjs"), mode],
      env: process.env,
    },
    process.cwd(),
    {
      notification() {},
      async request() {
        throw new Error("Unexpected reverse request");
      },
      exit() {},
    },
  );
}
it("preserves UTF-8 split across process output chunks", async () => {
  const peer = client("unicode");
  try {
    expect(await peer.request("echo", {})).toBe("Привет 🌍");
  } finally {
    await peer.close();
  }
});
it.each(["malformed", "oversized", "die"])(
  "rejects pending requests when the peer is %s",
  async (mode) => {
    const peer = client(mode);
    try {
      await expect(peer.request("echo", {})).rejects.toThrow();
    } finally {
      await peer.close();
    }
  },
);
it("bounds a stalled request and does not reuse a process with an unknown outcome", async () => {
  const peer = client("hang");
  try {
    await expect(peer.request("mutate", {}, 80)).rejects.toThrow("timed out");
    await expect(peer.request("next", {})).rejects.toThrow("not running");
  } finally {
    await peer.close();
  }
});
