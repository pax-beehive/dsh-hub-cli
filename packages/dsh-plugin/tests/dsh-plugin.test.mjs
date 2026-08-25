import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageUrl = new URL("../package.json", import.meta.url);
const sourceUrl = new URL("../index.js", import.meta.url);

test("agent adapter delegates to the public CLI package", async () => {
  const manifest = JSON.parse(await readFile(packageUrl, "utf8"));
  const source = await readFile(sourceUrl, "utf8");

  assert.equal(manifest.dependencies["@dsh-plugin-hub/cli"], "workspace:*");
  assert.match(source, /import\.meta\.resolve\('@dsh-plugin-hub\/cli\/bin'\)/);
  assert.match(source, /spawn\(process\.execPath, \[cli, \.\.\.args\]/);
});

test("all agent-triggered mutations require a reviewed operation plan", async () => {
  const source = await readFile(sourceUrl, "utf8");

  assert.match(source, /name: 'dsh_hub_operation_apply'/);
  assert.match(source, /if \(args\.confirmed !== true\) throw new Error\('Explicit user confirmation is required'\)/);
  assert.match(source, /\['operation', 'apply', args\.planId, '--json'\]/);
  assert.doesNotMatch(source, /execute\(args, exec\)[\s\S]*?\['profile', 'apply'.*?'--apply'/);
});
