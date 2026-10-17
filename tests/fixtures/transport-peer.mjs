import { createInterface } from "node:readline";
const mode = process.argv[2];
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (mode === "hang") return;
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
