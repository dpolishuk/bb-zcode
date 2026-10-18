import { stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import type { PromptInput } from "@get-bb/plugin-sdk/provider-bridge";
import { ProtocolError } from "./client.js";

const MAX_INLINE_BYTES = 16 * 1024 * 1024;
const mimeTypes: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".txt": "text/plain",
  ".md": "text/markdown",
};

/** Preserve the native attachment lane; the runtime reads local paths itself. */
export async function nativeInput(
  input: PromptInput[],
  cwd: string,
  fetcher: typeof fetch = fetch,
) {
  const parts: string[] = [],
    attachments: Record<string, unknown>[] = [];
  for (const item of input) {
    if (item.type === "text") {
      parts.push(item.text);
      if (item.mentions?.length)
        parts.push(
          `<bb_references>\n${JSON.stringify(item.mentions.map((m) => m.resource))}\n</bb_references>`,
        );
      continue;
    }
    if (item.type === "image") {
      let imageUrl = item.url;
      if (!imageUrl.startsWith("data:")) {
        try {
          const url = new URL(imageUrl);
          if (url.protocol !== "https:" || url.username || url.password)
            throw new Error();
          const response = await fetcher(imageUrl, {
            redirect: "error",
            signal: AbortSignal.timeout(15_000),
          });
          const mime = response.headers
            .get("content-type")
            ?.split(";")[0]
            .trim();
          if (!response.ok || !mime?.startsWith("image/") || !response.body)
            throw new Error();
          if (Number(response.headers.get("content-length")) > MAX_INLINE_BYTES)
            throw new Error();
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of response.body) {
            size += chunk.length;
            if (size > MAX_INLINE_BYTES) throw new Error();
            chunks.push(Buffer.from(chunk));
          }
          imageUrl = `data:${mime};base64,${Buffer.concat(chunks).toString("base64")}`;
        } catch {
          throw new ProtocolError(
            "Cannot load image. Use a valid HTTPS image or local file up to 16 MiB.",
            -32602,
          );
        }
      }
      const match =
        /^data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/]*={0,2})$/.exec(
          imageUrl,
        );
      if (
        !match ||
        !match[2] ||
        match[2].length > Math.ceil(MAX_INLINE_BYTES / 3) * 4
      )
        throw new ProtocolError(
          "Use a local image or an image data URL up to 16 MiB.",
          -32602,
        );
      const bytes = Buffer.from(match[2], "base64");
      if (bytes.toString("base64") !== match[2])
        throw new ProtocolError("Invalid image data URL.", -32602);
      attachments.push({
        kind: "image",
        filename: `image.${match[1].split("/")[1]}`,
        mimeType: match[1],
        dataBase64: match[2],
        sizeBytes: bytes.length,
      });
      continue;
    }
    const path = resolve(cwd, item.path);
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile())
      throw new ProtocolError(
        "The attached file is unavailable on the ZCode host.",
        -32602,
      );
    const mimeType =
      (item.type === "localFile" ? item.mimeType : undefined) ||
      mimeTypes[extname(path).toLowerCase()] ||
      "application/octet-stream";
    const kind =
      item.type === "localImage" || mimeType.startsWith("image/")
        ? "image"
        : mimeType === "application/pdf"
          ? "pdf"
          : mimeType.startsWith("video/")
            ? "video"
            : mimeType.startsWith("audio/")
              ? "audio"
              : "file";
    attachments.push({
      kind,
      localPath: path,
      filename:
        (item.type === "localFile" ? item.name : undefined) || basename(path),
      mimeType,
      sizeBytes: info.size,
    });
  }
  const content = parts.join("\n");
  if (!content.trim() && !attachments.length)
    throw new ProtocolError("A prompt or attachment is required.", -32602);
  return { content, ...(attachments.length ? { attachments } : {}) };
}
