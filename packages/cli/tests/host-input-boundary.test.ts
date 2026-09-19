import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { installResolvedProfile } from "../dist/index.js";
import { setProfileInput } from "../dist/profile-inputs.js";
import { fakeProfilePackageIntegrity, installFakeProfilePackageManager } from "./profile-package-manager-fixture.mjs";

const key = "HOST_BOUNDARY_INPUT", orphan = "HOST_A_ONLY_INPUT", marker = "DSH_HUB_STORED_INPUT_KEYS";
const savedA = "synthetic-stored-A-value", savedB = "synthetic-stored-B-value", external = "synthetic-explicit-value";
const cliUrl = new URL("../dist/bin.js", import.meta.url).href;
const adapterUrl = new URL("../../dsh-plugin/index.js", import.meta.url).href;
const pluginVersion = { version: "1.2.3", channel: "stable", manifest: { name: "boundary-plugin", version: "1.2.3", dsh: { bundle: { patch: "patch.yml" } } },
  source: { kind: "npm", packageName: "boundary-plugin", version: "1.2.3", installSpec: "boundary-plugin@1.2.3", tarballUrl: "https://fixture.invalid/plugin.tgz", integrity: fakeProfilePackageIntegrity },
  compatibility: { dsh: "*", platforms: [], surfaces: ["any"], hmr: "restart" }, entryIds: [], before: [], after: [], publishedAt: "2026-09-17T00:00:00.000Z", yanked: false };
const plugin = { id: "123e4567-e89b-12d3-a456-426614174000", slug: "boundary-plugin", packageName: "boundary-plugin", displayName: "Boundary fixture",
  summary: "Fixture", description: "", repository: "fixture/boundary-plugin", categories: [], keywords: [], screenshots: [], verified: false, deprecated: false,
  latestVersion: "1.2.3", distTags: { latest: "1.2.3" }, versions: [pluginVersion], createdAt: "2026-09-17T00:00:00.000Z", updatedAt: "2026-09-17T00:00:00.000Z" };

type Event = { phase: string; value?: string; orphan?: string; marker?: string; args?: string[] };
function processResult(script: string, args: string[], env: NodeJS.ProcessEnv): Promise<{code: number | null; stdout: string; stderr: string}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk);
    child.once("error", reject); child.once("close", code => resolve({ code, stdout, stderr }));
  });
}
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "dsh-host-input-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const events = join(root, "events.jsonl"), wrapper = join(root, "cli-wrapper.mjs"), driver = join(root, "host-driver.mjs"), bin = join(root, "bin");
  await mkdir(bin);
  // Every process gets an isolated home and a small explicit environment, never the user's input store.
  const env = { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, DSH_HOME: root,
    DSH_HUB_API_URL: "https://fixture.invalid/api/v1", DSH_HUB_TELEMETRY: "0" };
  await writeFile(events, "");
  const log = `const fs=require('node:fs'),path=require('node:path');function record(phase,args){fs.appendFileSync(path.join(process.env.DSH_HOME,'events.jsonl'),JSON.stringify({phase,value:process.env.${key},orphan:process.env.${orphan},marker:process.env.${marker},args})+'\\n');}`;
  await writeFile(wrapper, `import {appendFileSync} from 'node:fs';
globalThis.fetch=async(url)=>{appendFileSync(${JSON.stringify(join(root, "network.jsonl"))},JSON.stringify({url:String(url)})+'\\n');if(!String(url).endsWith('/packages/resolve?name=boundary-plugin'))throw new Error('Unexpected fixture request');return new Response(${JSON.stringify(JSON.stringify(plugin))},{status:200,headers:{'content-type':'application/json'}});};
await import(${JSON.stringify(cliUrl)});
`);
  const runtimeScript = `${log}
const args=process.argv.slice(2);const profile=args[args.indexOf('--profile')+1];
if(args[0]==='plugin'||args[0]==='--fixture-global'){record('plugin-command',args);const child=require('node:child_process').spawnSync(process.execPath,[${JSON.stringify(join(root, "plugin-install.cjs"))},...args],{env:process.env,stdio:'inherit'});process.exit(child.status??1);}
if(args.includes('--dump-config')){record('validation-B',args);process.exit(0);}
if(profile==='A'){record('host-A',args);import(${JSON.stringify(pathToFileURL(driver).href)}).catch(()=>{console.error('Host fixture failed');process.exitCode=1;});}
else{record('run-B',args);process.exit(0);}
`;
  await writeFile(join(root, "runtime.cjs"), runtimeScript);
  await writeFile(join(root, "plugin-install.cjs"), `${log}
record('plugin-script',process.argv.slice(2));const args=process.argv.slice(2),profile=args[args.indexOf('--profile')+1],spec=args.at(-1),offset=spec.lastIndexOf('@'),name=spec.slice(0,offset),version=spec.slice(offset+1);
const directory=path.join(process.env.DSH_HOME,'profiles',profile,'node_modules',...name.split('/'));fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'package.json'),JSON.stringify({name,version,dsh:{bundle:{patch:'patch.yml'}}}));fs.writeFileSync(path.join(directory,'patch.yml'),'[]\\n');
`);
  const lifecycleScript = join(root, "pm-lifecycle.cjs");
  await writeFile(lifecycleScript, `${log}\nrecord('plugin-script',process.argv.slice(2));\n`);
  await installFakeProfilePackageManager(root, { lifecycleScript, eventFile: events,
    recordFields: { value: key, orphan, marker } });
  await writeFile(join(bin, "npm"), `#!${process.execPath}\n${log}
record('npm-script',process.argv.slice(2));const args=process.argv.slice(2),prefix=args[args.indexOf('--prefix')+1],version=args.at(-1).slice('@deepseek-ai/dsh@'.length),pkg=path.join(prefix,'node_modules','@deepseek-ai','dsh');
fs.mkdirSync(pkg,{recursive:true});fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({name:'@deepseek-ai/dsh',version,bin:{dsh:'bin.cjs'}}));fs.copyFileSync(${JSON.stringify(join(root, "runtime.cjs"))},path.join(pkg,'bin.cjs'));
`, { mode: 0o700 });
  for (const [profile, version, value] of [["A", "0.1.0", savedA], ["B", "0.2.0", savedB]]) {
    await setProfileInput(profile, key, value, root);
    if (profile === "A") await setProfileInput(profile, orphan, "synthetic-A-only-value", root);
    const inputs = [{ key, label: "Shared input", required: true, secret: true }, ...(profile === "A" ? [{ key: orphan, label: "A only", required: true, secret: true }] : [])];
    const bundle = { packageName: "@deepseek-ai/dsh-base", selector: version, version, installSpec: `builtin:@deepseek-ai/dsh-base@${version}`, sourceKind: "builtin" as const };
    const release = { schemaVersion: 1 as const, version: "1.0.0", name: profile, description: "", dsh: "*", runtime: { range: "*", version },
      bundles: [{ ...bundle, before: [], after: [] }], patch: [], patchYaml: "[]\n", inputs, publishedAt: "2026-09-17T00:00:00.000Z" };
    await installResolvedProfile({ profile, dshHome: root, release, resolved: { profileVersion: "1.0.0", bundles: [bundle] }, hubProfileSlug: `fixture-${profile.toLowerCase()}`,
      execute: async () => {}, validate: async () => {} });
  }
  // A is ready; B deliberately has no runtime cache so its actual npm preparation is covered.
  const cachedA = join(root, ".hub", "runtimes", "0.1.0", "node_modules", "@deepseek-ai", "dsh");
  await mkdir(cachedA, { recursive: true });
  await writeFile(join(cachedA, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.1.0", bin: { dsh: "bin.cjs" } }));
  await writeFile(join(cachedA, "bin.cjs"), runtimeScript);
  await writeFile(driver, `import {createCliRunner,createTools} from ${JSON.stringify(adapterUrl)};
import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';
const adapter=createCliRunner({cliPath:${JSON.stringify(wrapper)}});
const direct=(args)=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[${JSON.stringify(wrapper)},...args],{env:process.env,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('close',code=>{if(code!==0)return reject(new Error('Nested CLI failed'));try{resolve(out.trim().split('\\n').map(x=>JSON.parse(x)));}catch{reject(new Error('Nested JSON failed'));}});child.on('error',reject);});
const exec={signal:new AbortController().signal};let plan;
if(process.env.BOUNDARY_ROUTE==='adapter'){
const tools=new Map(createTools(adapter).map(t=>[t.name,t]));plan=await tools.get('dsh_hub_plugin_plan').execute({packageName:'boundary-plugin',version:'1.2.3',profile:'B'},exec);
await tools.get('dsh_hub_operation_apply').execute({planId:plan.id,confirmed:true},exec);
await adapter(['profile','run','--profile','B','--json']);
}else{plan=(await direct(['install','boundary-plugin','--version','1.2.3','--profile','B','--plan','--json']))[0];await direct(['operation','apply',plan.id,'--json']);await direct(['profile','run','--profile','B','--json']);}
writeFileSync(${JSON.stringify(join(root, "host-complete.json"))},JSON.stringify({done:true,planId:plan.id}));
`);
  return { root, wrapper, driver, env, events };
}
async function readEvents(path: string): Promise<Event[]> {
  return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}
function assertNoValues(output: string) {
  for (const value of [savedA, savedB, external, "synthetic-A-only-value"]) assert.equal(output.includes(value), false);
}

for (const route of ["adapter", "nested"] as const) {
  test(`A saved inputs cross the ${route} boundary safely; only B validation/run receive B's saved value`, async t => {
    const { root, wrapper, env, events } = await fixture(t);
    const result = await processResult(wrapper, ["profile", "run", "--profile", "A", "--json"], { ...env, BOUNDARY_ROUTE: route });
    assert.equal(result.code, 0, result.stderr); assertNoValues(`${result.stdout}${result.stderr}`);
    assert.equal(JSON.parse(await readFile(join(root, "host-complete.json"), "utf8")).done, true);
    const observed = await readEvents(events), host = observed.find(event => event.phase === "host-A")!;
    assert.equal(host.value, savedA); assert.equal(host.orphan, "synthetic-A-only-value");
    assert.deepEqual(JSON.parse(host.marker!), { v: 1, keys: [key, orphan].sort() });
    for (const phase of ["npm-script", "pm-config", "pm-resolution", "pm-install", "plugin-script"]) {
      const event = observed.find(event => event.phase === phase); assert.ok(event, `missing ${phase}`);
      assert.equal(event.value, undefined, phase); assert.equal(event.orphan, undefined, phase); assert.equal(event.marker, undefined, phase);
    }
    for (const phase of ["validation-B", "run-B"]) {
      const event = observed.find(event => event.phase === phase); assert.ok(event, `missing ${phase}`);
      assert.equal(event.value, savedB, phase); assert.equal(event.orphan, undefined, phase);
      assert.deepEqual(JSON.parse(event.marker!), { v: 1, keys: [key] });
    }
    assertNoValues(await readFile(join(root, "network.jsonl"), "utf8"));
  });

  test(`a genuine explicit environment value keeps priority through ${route} while A-only saved inputs are removed`, async t => {
    const { root, wrapper, env, events } = await fixture(t);
    const result = await processResult(wrapper, ["profile", "run", "--profile", "A", "--json"], { ...env, BOUNDARY_ROUTE: route, [key]: external });
    assert.equal(result.code, 0, result.stderr); assertNoValues(`${result.stdout}${result.stderr}`);
    const observed = await readEvents(events);
    assert.deepEqual(JSON.parse(observed.find(event => event.phase === "host-A")!.marker!), { v: 1, keys: [orphan] });
    for (const phase of ["npm-script", "pm-config", "pm-resolution", "pm-install", "plugin-script", "validation-B", "run-B"]) {
      const event = observed.find(event => event.phase === phase); assert.ok(event, `missing ${phase}`);
      assert.equal(event.value, external, phase); assert.equal(event.orphan, undefined, phase); assert.equal(event.marker, undefined, phase);
    }
    assertNoValues(await readFile(join(root, "network.jsonl"), "utf8"));
  });
}

test("invalid provenance is rejected by the adapter before spawn and by direct CLI before preparation", async t => {
  const { root, wrapper, env, events } = await fixture(t), probe = join(root, "invalid-adapter.mjs");
  await writeFile(probe, `import {createCliRunner} from ${JSON.stringify(adapterUrl)};import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';
const run=createCliRunner({cliPath:${JSON.stringify(wrapper)},spawnProcess(...args){writeFileSync(${JSON.stringify(join(root, "unexpected-spawn"))},'called');return spawn(...args);}});
try{await run(['runtime','prepare','--runtime-version','0.3.0','--json']);console.log('unexpected success');process.exitCode=1;}catch(error){console.log(JSON.stringify({error:error.code,message:error.message}));}
`);
  const invalid = ["{synthetic-marker-value", JSON.stringify({ v: 1, keys: ["PATH"] }), JSON.stringify({ v: 1, keys: [key, key] }),
    JSON.stringify({ v: 1, keys: [key], extra: "synthetic-marker-value" }), JSON.stringify({ v: 1, keys: Array.from({ length: 1025 }, (_, index) => `INPUT_${index}`) }),
    " ".repeat(65537)];
  for (const value of invalid) {
    const marked = { ...env, [key]: savedA, [marker]: value };
    const adapter = await processResult(probe, [], marked);
    assert.equal(adapter.code, 0, adapter.stderr); assert.match(adapter.stdout, /CLI_INPUT_PROVENANCE_INVALID/);
    const direct = await processResult(wrapper, ["runtime", "prepare", "--runtime-version", "0.3.0", "--json"], marked);
    assert.equal(direct.code, 1); assertNoValues(`${adapter.stdout}${adapter.stderr}${direct.stdout}${direct.stderr}`);
    assert.equal(`${adapter.stdout}${direct.stderr}`.includes("synthetic-marker-value"), false);
  }
  await assert.rejects(readFile(join(root, "unexpected-spawn")), { code: "ENOENT" });
  assert.deepEqual(await readEvents(events), []);
});

test("an older host without provenance treats inherited values as explicit environment", async t => {
  const { wrapper, env, events } = await fixture(t);
  const result = await processResult(wrapper, ["profile", "run", "--profile", "B", "--json"], { ...env, [key]: savedA });
  assert.equal(result.code, 0, result.stderr); assertNoValues(`${result.stdout}${result.stderr}`);
  const observed = await readEvents(events);
  for (const phase of ["npm-script", "run-B"]) {
    const event = observed.find(event => event.phase === phase)!;
    assert.equal(event.value, savedA); assert.equal(event.marker, undefined);
  }
});

test("the library executor strips marked explicit values from plugin installation", async t => {
  const { root, env, events } = await fixture(t), script = join(root, "library-install.mjs");
  await writeFile(script, `import {buildDshInstallCommand,executeDshCommand} from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
const env={...process.env,${key}:${JSON.stringify(savedA)},${orphan}:'synthetic-A-only-value',${marker}:JSON.stringify({v:1,keys:[${JSON.stringify(key)},${JSON.stringify(orphan)}]})};
await executeDshCommand(buildDshInstallCommand('B','boundary-plugin@1.2.3','0.2.0'),process.env.DSH_HOME,env);console.log('done');
`);
  const result = await processResult(script, [], env);
  assert.equal(result.code, 0, result.stderr); assertNoValues(`${result.stdout}${result.stderr}`);
  const observed = await readEvents(events);
  for (const phase of ["npm-script", "plugin-command", "plugin-script"]) {
    const event = observed.find(event => event.phase === phase); assert.ok(event, `missing ${phase}`);
    assert.equal(event.value, undefined); assert.equal(event.orphan, undefined); assert.equal(event.marker, undefined);
  }
});

test("an invalid explicit library environment is rejected before runtime cache or child creation", async t => {
  const { root, env, events } = await fixture(t), script = join(root, "library-invalid-explicit.mjs");
  await writeFile(script, `import {buildDshInstallCommand,executeDshCommand} from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
try{await executeDshCommand(buildDshInstallCommand('B','boundary-plugin@1.2.3','0.2.0'),process.env.DSH_HOME,{...process.env,${key}:${JSON.stringify(savedA)},${marker}:'synthetic-invalid-marker'});console.log('unexpected success');}
catch(error){console.error(error.message);process.exitCode=1;}
`);
  const result = await processResult(script, [], env);
  assert.equal(result.code, 1); assert.match(result.stderr, /Invalid stored-input environment marker/);
  assertNoValues(`${result.stdout}${result.stderr}`); assert.equal(result.stderr.includes("synthetic-invalid-marker"), false);
  assert.deepEqual(await readEvents(events), []);
  await assert.rejects(lstat(join(root, ".hub", "runtimes", "0.2.0")), { code: "ENOENT" });
  await assert.rejects(readFile(join(root, ".hub", "runtimes", "0.2.0.lock")), { code: "ENOENT" });
});

test("invalid inherited provenance reaches neither library mutation entry point's lock directory", async t => {
  const { root, env, events } = await fixture(t), script = join(root, "library-invalid-mutation.mjs"), patch = join(root, "new-patch.yml");
  await writeFile(patch, "[]\n");
  await writeFile(script, `import {installResolvedProfile,applyProfileEdit} from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
const bundle={packageName:'@deepseek-ai/dsh-base',selector:'0.3.0',version:'0.3.0',installSpec:'builtin:@deepseek-ai/dsh-base@0.3.0',sourceKind:'builtin'};
try{if(process.argv[2]==='install')await installResolvedProfile({profile:'new-install',dshHome:process.env.DSH_HOME,resolved:{profileVersion:'1.0.0',bundles:[bundle]},execute:async()=>{throw new Error('unexpected execution');}});
else await applyProfileEdit({profile:'new-edit',dshHome:process.env.DSH_HOME,runtimeVersion:'0.3.0',intent:{kind:'configure',patchFile:${JSON.stringify(patch)}}});console.log('unexpected success');}
catch(error){console.error(error.message);process.exitCode=1;}
`);
  for (const action of ["install", "edit"]) {
    const result = await processResult(script, [action], { ...env, [key]: savedA, [marker]: "synthetic-invalid-marker" });
    assert.equal(result.code, 1); assert.match(result.stderr, /Invalid stored-input environment marker/);
    assertNoValues(`${result.stdout}${result.stderr}`); assert.equal(result.stderr.includes("synthetic-invalid-marker"), false);
    await assert.rejects(lstat(join(root, ".hub", "installations", `new-${action}`)), { code: "ENOENT" });
    await assert.rejects(lstat(join(root, "profiles", `new-${action}`)), { code: "ENOENT" });
  }
  assert.deepEqual(await readEvents(events), []);
});

test("noncanonical library commands are sanitized while a canonical Profile named plugin keeps target inputs", async t => {
  const { root, env, events } = await fixture(t), script = join(root, "library-canonical-boundary.mjs");
  // The fixture runtime accepts an extra prefix; the public executor must not rely
  // on one host parser's current plugin-token position to enforce its boundary.
  await writeFile(script, `import {executeDshCommand} from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
const env={...process.env,${key}:${JSON.stringify(savedB)},${marker}:JSON.stringify({v:1,keys:[${JSON.stringify(key)}]})};
await executeDshCommand({command:'npx',args:['-y','@deepseek-ai/dsh@0.2.0','--fixture-global','plugin','--profile','B','add','boundary-plugin@1.2.3']},process.env.DSH_HOME,env);
await executeDshCommand({command:'npx',args:['-y','@deepseek-ai/dsh@0.2.0','--profile','plugin']},process.env.DSH_HOME,env);console.log('done');
`);
  const result = await processResult(script, [], env);
  assert.equal(result.code, 0, result.stderr); assertNoValues(`${result.stdout}${result.stderr}`);
  const observed = await readEvents(events);
  for (const phase of ["npm-script", "plugin-command", "plugin-script"]) {
    const event = observed.find(event => event.phase === phase); assert.ok(event, `missing ${phase}`);
    assert.equal(event.value, undefined); assert.equal(event.marker, undefined);
  }
  const launched = observed.find(event => event.phase === "run-B")!;
  assert.deepEqual(launched.args, ["--profile", "plugin"]); assert.equal(launched.value, savedB);
  assert.deepEqual(JSON.parse(launched.marker!), { v: 1, keys: [key] });
});
