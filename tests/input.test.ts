import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { nativeInput } from "../src/input.js";

it("downloads an HTTPS image with bounded transfer and no redirects", async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(Buffer.from("iVBORw0KGgo=", "base64"), {
        headers: { "content-type": "image/png" },
      }),
  );
  const output = await nativeInput(
    [{ type: "image", url: "https://images.example/test.png" }],
    "/tmp",
    fetcher,
  );
  expect(output.attachments?.[0]).toMatchObject({
    kind: "image",
    mimeType: "image/png",
    dataBase64: "iVBORw0KGgo=",
  });
  expect(fetcher).toHaveBeenCalledWith(
    "https://images.example/test.png",
    expect.objectContaining({
      redirect: "error",
      signal: expect.any(AbortSignal),
    }),
  );
});

it.each([
  "http://images.example/x",
  "file:///tmp/x",
  "https://user:secret@images.example/x",
])("rejects unsafe image URL %s before fetching", async (url) => {
  const fetcher = vi.fn();
  await expect(
    nativeInput([{ type: "image", url }], "/tmp", fetcher),
  ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});

it("rejects oversized HTTPS images before consuming their body", async () => {
  const fetcher = vi.fn(
    async () =>
      new Response("", {
        headers: {
          "content-type": "image/png",
          "content-length": String(17 * 1024 * 1024),
        },
      }),
  );
  await expect(
    nativeInput(
      [{ type: "image", url: "https://images.example/x" }],
      "/tmp",
      fetcher,
    ),
  ).rejects.toThrow(/16 MiB/);
});

it("preserves structured file mentions as model-visible references", async () => {
  const result = await nativeInput(
    [
      {
        type: "text",
        text: "Inspect @file",
        mentions: [
          {
            start: 8,
            end: 13,
            resource: {
              kind: "path",
              entryKind: "file",
              source: "workspace",
              path: "/workspace/example.ts",
              label: "example.ts",
            },
          },
        ],
      },
    ],
    "/tmp",
  );
  expect(result.content).toContain("/workspace/example.ts");
  expect(result.content).toContain("Inspect @file");
});

it("rejects missing files, directories and malformed image data without reading a model", async () => {
  const directory = mkdtempSync(`${tmpdir()}/bb-zcode-input-`);
  await expect(
    nativeInput([{ type: "localFile", path: directory }], directory),
  ).rejects.toThrow(/unavailable/);
  await expect(
    nativeInput(
      [{ type: "localImage", path: `${directory}/missing.png` }],
      directory,
    ),
  ).rejects.toThrow(/unavailable/);
  await expect(
    nativeInput(
      [{ type: "image", url: "data:image/png;base64,abc" }],
      directory,
    ),
  ).rejects.toThrow(/Invalid/);
});
