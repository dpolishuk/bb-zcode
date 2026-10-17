import { StringDecoder } from "node:string_decoder";
import type { ChildProcess } from "node:child_process";
import {
  experimental_spawnPortableProcess,
  experimental_killPortableProcess,
  experimental_recordProviderChildIo,
} from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";
import type { LaunchSpec } from "./launch.js";

const frameSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    method: z.string().optional(),
    params: z.unknown().optional(),
    result: z.unknown().optional(),
    error: z
      .object({ code: z.number(), message: z.string() })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type Frame = z.infer<typeof frameSchema>;
export class ProtocolError extends Error {
  constructor(
    message: string,
    readonly code = -32000,
  ) {
    super(message);
  }
}
export interface ZCodeConnection {
  request(
    method: string,
    params: unknown,
    timeoutMs?: number,
  ): Promise<unknown>;
  close(): Promise<void>;
}
export interface ClientCallbacks {
  notification(frame: Frame): void;
  request(method: string, params: unknown): Promise<unknown>;
  exit(error: Error): void;
}

// ZCode frames deliberately have no `jsonrpc` field. bb's frames do.
export class ZCodeClient implements ZCodeConnection {
  private child: ChildProcess;
  private pending = new Map<
    string | number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private nextId = 0;
  private buffer = "";
  private decoder = new StringDecoder("utf8");
  private dead = false;
  private closing = false;
  private closePromise?: Promise<void>;

  constructor(
    launch: LaunchSpec,
    cwd: string,
    private callbacks: ClientCallbacks,
    threadId: string | null = null,
  ) {
    this.child = experimental_spawnPortableProcess({
      ...launch,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    experimental_recordProviderChildIo(this.child, { threadId });
    this.child.stdout!.on("data", (chunk: Buffer) => this.receive(chunk));
    this.child.stderr!.on("data", () => {
      /* drain diagnostics; never forward credentials or unbounded logs */
    });
    this.child.stdin!.on("error", () =>
      this.fail(new Error("ZCode stdin closed.")),
    );
    this.child.on("error", (error) =>
      this.fail(new Error(`Cannot launch ZCode: ${error.message}`)),
    );
    this.child.on("exit", (code, signal) =>
      this.fail(
        new Error(
          `ZCode exited (${signal ?? code ?? "unknown"}). Check the executable and provider configuration.`,
        ),
      ),
    );
  }

  private send(frame: Frame) {
    if (this.dead || !this.child.stdin?.writable)
      throw new Error("ZCode is not running.");
    this.child.stdin.write(JSON.stringify(frame) + "\n");
  }

  request(
    method: string,
    params: unknown,
    timeoutMs = 30_000,
  ): Promise<unknown> {
    if (this.dead || this.closing)
      return Promise.reject(new Error("ZCode is not running."));
    const id = `bb-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`ZCode timed out: ${method}`);
        reject(error);
        // The outcome of a mutating request is unknown; do not reuse the process.
        this.fail(error);
        void this.close();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private receive(chunk: Buffer) {
    this.buffer += this.decoder.write(chunk);
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      if (newline > 8 * 1024 * 1024) return this.corrupt();
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let frame: Frame;
      try {
        frame = frameSchema.parse(JSON.parse(line));
      } catch {
        return this.corrupt();
      }
      if (frame.method) {
        if (frame.id !== undefined) {
          void this.callbacks
            .request(frame.method, frame.params)
            .then(
              (result) => {
                if (!this.dead && !this.closing)
                  this.send({ id: frame.id, result });
              },
              (error) => {
                if (!this.dead && !this.closing)
                  this.send({
                    id: frame.id,
                    error: {
                      code:
                        error instanceof ProtocolError ? error.code : -32603,
                      message:
                        error instanceof Error
                          ? error.message
                          : "Host request failed",
                    },
                  });
              },
            )
            .catch(() =>
              this.fail(new Error("Cannot answer ZCode host request.")),
            );
        } else {
          try {
            this.callbacks.notification(frame);
          } catch {
            this.corrupt();
            return;
          }
        }
      } else if (frame.id !== undefined) {
        const pending = this.pending.get(frame.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(frame.id);
        if (frame.error)
          pending.reject(
            new ProtocolError(frame.error.message, frame.error.code),
          );
        else pending.resolve(frame.result);
      } else {
        this.corrupt();
        return;
      }
    }
    if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024) this.corrupt();
  }

  private corrupt() {
    this.fail(new Error("Invalid or oversized ZCode protocol frame."));
    void this.close();
  }
  private fail(error: Error) {
    if (this.dead) return;
    this.dead = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (!this.closing) {
      this.callbacks.exit(error);
      void this.close();
    }
  }

  close(): Promise<void> {
    return (this.closePromise ??= this.closeProcess());
  }
  private async closeProcess() {
    this.closing = true;
    this.fail(new Error("ZCode connection closed."));
    this.child.stdin?.end();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1800);
        this.child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    // Also clean up descendants which outlive the stdio server.
    try {
      if (process.platform !== "win32" && this.child.pid)
        process.kill(-this.child.pid, "SIGKILL");
      else experimental_killPortableProcess(this.child, "SIGKILL");
    } catch {
      /* already exited */
    }
    this.child.stdout?.destroy();
    this.child.stderr?.destroy();
  }
}
