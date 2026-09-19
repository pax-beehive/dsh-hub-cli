import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { assertProfileInputValue } from "./profile-inputs.js";

export async function readProfileInputValue(fromStdin: boolean, key: string): Promise<string> {
  if (fromStdin) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const raw of process.stdin) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      size += chunk.length;
      if (size > 64 * 1024 + 2) throw new Error("Input value exceeds the 64 KiB limit");
      chunks.push(chunk);
    }
    const value = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
    assertProfileInputValue(value);
    return value;
  }
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error("Use --stdin to supply the value through standard input, or run in an interactive terminal; values are not accepted as arguments");
  }
  // All values use a hidden terminal, including values not marked secret by a Release.
  const hiddenOutput = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const terminal = createInterface({ input: process.stdin, output: hiddenOutput, terminal: true, historySize: 0 });
  process.stderr.write(`Value for ${key} (hidden): `);
  try {
    const value = await new Promise<string>((resolve, reject) => {
      terminal.once("SIGINT", () => reject(new Error("Input entry cancelled")));
      terminal.once("close", () => reject(new Error("Input entry cancelled")));
      terminal.question("", resolve);
    });
    assertProfileInputValue(value);
    return value;
  } finally {
    terminal.close();
    hiddenOutput.destroy();
    process.stderr.write("\n");
  }
}
