import { createInterface } from "node:readline";
const mode = process.argv[2];
const input = createInterface({ input: process.stdin });
// Reverse mode: immediately ask the host something; the host's own request
// is answered only after the reverse request received a reply (the denial).
let reverseAnswered = false;
let pendingHost = null;
if (mode === "reverse")
  process.stdout.write(
    JSON.stringify({ id: "peer-1", method: "host/ping" }) + "\n",
  );
const flushReverse = () => {
  if (reverseAnswered && pendingHost) {
    const { id } = pendingHost;
    pendingHost = null;
    process.stdout.write(JSON.stringify({ id, result: "ok" }) + "\n");
  }
};
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (mode === "reverse") {
    if (request.id === "peer-1") reverseAnswered = true;
    else if (request.method) pendingHost = request;
    flushReverse();
    return;
  }
  if (mode === "hang") return;
  if (mode === "hang-poll" && request.method === "poll") return;
  if (mode === "malformed") {
    process.stdout.write("not-json\n");
    return;
  }
  if (mode === "oversized") {
    process.stdout.write("x".repeat(8 * 1024 * 1024 + 1));
    return;
  }
  if (mode === "die") {
    process.exit(2);
  }
  const bytes = Buffer.from(
    JSON.stringify({ id: request.id, result: "Привет 🌍" }) + "\n",
  );
  const split = bytes.indexOf(Buffer.from("🌍")) + 2;
  process.stdout.write(bytes.subarray(0, split));
  setTimeout(() => process.stdout.write(bytes.subarray(split)), 5);
});
input.on("close", () => {
  process.stdin.destroy();
});
