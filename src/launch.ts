import { existsSync, accessSync, constants } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";

export const launchOptionsSchema = z.object({
  executable: z.string().default(""),
  args: z.array(z.string()).default([]),
  nodeExecutable: z.string().default("node"),
});
export type LaunchOptions = z.infer<typeof launchOptionsSchema>;
export interface LaunchSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

function onPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const suffix of process.platform === "win32"
      ? ["", ".exe", ".cmd"]
      : [""]) {
      const candidate = join(dir, name + suffix);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        /* next */
      }
    }
  }
}

export function resolveLaunch(
  raw: unknown = {},
  env: NodeJS.ProcessEnv = process.env,
): LaunchSpec {
  const options = launchOptionsSchema.parse(raw ?? {});
  const explicit = options.executable.trim() || env.BB_ZCODE_EXECUTABLE?.trim();
  const bundle = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
  const executable =
    explicit ||
    onPath("zcode", env) ||
    (process.platform === "darwin" && existsSync(bundle) ? bundle : undefined);
  if (!executable)
    throw new Error(
      "ZCode was not found. Install ZCode or set the plugin executable setting.",
    );
  const childEnv = { ...env };
  // Electron's Node mode must not leak into a separately launched CLI.
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const isScript = /\.[cm]?js$/i.test(executable);
  if (isScript) {
    const config = resolve(
      dirname(executable),
      "../config/provider/zcode-builtin.json",
    );
    if (existsSync(config) && !childEnv.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE) {
      childEnv.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = config;
    }
  }
  return {
    command: isScript
      ? env.BB_ZCODE_NODE_EXECUTABLE || options.nodeExecutable
      : executable,
    args: [
      ...(isScript ? [executable] : []),
      ...options.args,
      "app-server",
      "--stdio",
      "--surface",
      "terminal",
    ],
    env: childEnv,
  };
}

export function workspaceRef(cwd: string) {
  const workspacePath = resolve(cwd || homedir());
  return { workspacePath, workspaceKey: `bb:${workspacePath}` };
}
