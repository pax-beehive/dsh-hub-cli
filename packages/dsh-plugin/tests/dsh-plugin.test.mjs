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
  assert.match(source, /name: 'dsh_hub_plugin_plan'/);
  assert.match(source, /\['install', args\.packageName[\s\S]*?'--plan', '--json'\]/);
  assert.doesNotMatch(source, /execute\(args, exec\)[\s\S]*?\['profile', 'apply'.*?'--apply'/);
});

test("agent tools expose catalog review and Profile lifecycle reads", async () => {
  const source = await readFile(sourceUrl, "utf8");
  for (const name of [
    "dsh_hub_search",
    "dsh_hub_plugin_info",
    "dsh_hub_profile_diff",
    "dsh_hub_profile_upgrade_plan",
    "dsh_hub_profile_doctor",
  ]) {
    assert.match(source, new RegExp(`name: '${name}'`));
  }
});
