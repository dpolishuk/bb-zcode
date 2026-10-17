import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

// Prefer an explicit CLI, then the installed macOS desktop CLI, then PATH.
const desktop = "/Applications/bb.app/Contents";
const bundled = `${desktop}/Resources/app.asar/node_modules/bb-app/dist/bb.js`;
const useDesktop =
  !process.env.BB_CLI &&
  process.platform === "darwin" &&
  existsSync(`${desktop}/MacOS/bb`);
const result = spawnSync(
  process.env.BB_CLI || (useDesktop ? `${desktop}/MacOS/bb` : "bb"),
  [...(useDesktop ? [bundled] : []), ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      ...(useDesktop ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    },
  },
);
if (result.error)
  console.error(
    "Install bb, put its CLI on PATH, or set BB_CLI to an executable:",
    result.error.message,
  );
process.exitCode = result.status ?? 1;
