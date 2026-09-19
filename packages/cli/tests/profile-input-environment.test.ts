import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HubProfileVersion } from "@dsh-plugin-hub/schemas";
import { DSH_HUB_STORED_INPUT_KEYS, listProfileInputs, resolveProfileInputs, setProfileInput, stripStoredInputEnvironment } from "../dist/profile-inputs.js";

const marker = (keys: string[]) => JSON.stringify({ v: 1, keys });
const declaration = (key: string, secret = true): HubProfileVersion["inputs"][number] => ({ key, label: key, required: true, secret });
async function homeFor(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), "dsh-input-provenance-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

test("an unmarked legacy environment is copied without guessing which values were saved", () => {
  const original = { PATH: "/trusted/bin", DSH_HOME: "/trusted/home", SERVICE_KEY: "legacy-host-value", OPTIONAL: undefined };
  const clean = stripStoredInputEnvironment(original);
  assert.deepEqual(clean, original); assert.notEqual(clean, original);
  clean.SERVICE_KEY = "different";
  assert.equal(original.SERVICE_KEY, "legacy-host-value");
});

test("provenance removes only marked inputs and marker aliases without mutating its source", () => {
  const original = { PATH: "/trusted/bin", Dsh_Home: "/trusted/home", NODE_OPTIONS: "--trace-warnings", EXTERNAL_KEY: "external",
    SERVICE_KEY: "saved-a", Service_Key: "saved-alias", service_key: "saved-lower", PUBLIC_INPUT: "saved-public",
    dsh_hub_stored_input_keys: marker(["SERVICE_KEY", "PUBLIC_INPUT"]) };
  assert.deepEqual(stripStoredInputEnvironment(original, "win32"), { PATH: "/trusted/bin", Dsh_Home: "/trusted/home", NODE_OPTIONS: "--trace-warnings", EXTERNAL_KEY: "external" });
  assert.equal(original.SERVICE_KEY, "saved-a"); assert.equal(original.dsh_hub_stored_input_keys, marker(["SERVICE_KEY", "PUBLIC_INPUT"]));
});

test("a valid empty key list clears provenance while an empty string or empty object is invalid", () => {
  assert.deepEqual(stripStoredInputEnvironment({ SERVICE_KEY: "external", [DSH_HUB_STORED_INPUT_KEYS]: marker([]) }), { SERVICE_KEY: "external" });
  for (const value of ["", " ", "{}", "[]", "null"]) {
    assert.throws(() => stripStoredInputEnvironment({ SERVICE_KEY: "keep", [DSH_HUB_STORED_INPUT_KEYS]: value }), /Invalid stored-input environment marker/);
  }
});

test("malformed, unversioned, oversized and duplicated provenance fails without echoing content", () => {
  const privateMarker = "private-marker-content-must-not-appear";
  const invalid: unknown[] = [undefined, marker(["lower_case"]), marker(["DUPLICATE", "DUPLICATE"]),
    JSON.stringify({ v: 2, keys: ["SERVICE_KEY"] }), JSON.stringify({ v: "1", keys: [] }), JSON.stringify({ keys: [] }),
    JSON.stringify({ v: 1, keys: [], values: privateMarker }), JSON.stringify({ v: 1, keys: null }), JSON.stringify({ v: 1, keys: [1] }),
    JSON.stringify({ v: 1, keys: [privateMarker] }), privateMarker, marker([]) + " ".repeat(64 * 1024),
    marker(Array.from({ length: 1025 }, (_, i) => `INPUT_${i}`))];
  for (const raw of invalid) {
    const original: NodeJS.ProcessEnv = { SERVICE_KEY: "private-value", [DSH_HUB_STORED_INPUT_KEYS]: raw as string | undefined };
    assert.throws(() => stripStoredInputEnvironment(original), (error: unknown) => {
      assert.ok(error instanceof Error); assert.match(error.message, /Invalid stored-input environment marker/);
      assert.equal(error.message.includes(privateMarker), false); assert.equal(error.message.includes("private-value"), false); return true;
    });
    assert.equal(original.SERVICE_KEY, "private-value");
  }
});

test("provenance cannot delete protected process controls, including Windows case aliases", () => {
  for (const key of ["PATH", "Path", "path", "DSH_HOME", "Dsh_Home", "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "HOME", "SYSTEMROOT",
    "NPM_CONFIG_USERCONFIG", "PNPM_HOME", "COREPACK_HOME", "GIT_CONFIG_GLOBAL", "LD_PRELOAD", DSH_HUB_STORED_INPUT_KEYS]) {
    const original = { PATH: "/trusted/bin", Path: "/trusted/alias", DSH_HOME: "/trusted/home", [DSH_HUB_STORED_INPUT_KEYS]: marker([key]) };
    assert.throws(() => stripStoredInputEnvironment(original), /Invalid stored-input environment marker/);
    assert.equal(original.PATH, "/trusted/bin"); assert.equal(original.Path, "/trusted/alias"); assert.equal(original.DSH_HOME, "/trusted/home");
  }
  assert.throws(() => stripStoredInputEnvironment({ [DSH_HUB_STORED_INPUT_KEYS]: marker([]), dsh_hub_stored_input_keys: marker([]) }), /Invalid stored-input environment marker/);
});

test("nested input resolution selects the target store and preserves genuine external overrides", async t => {
  const home = await homeFor(t), key = "SERVICE_KEY", external = "EXTERNAL_KEY", plain = "PUBLIC_INPUT";
  await setProfileInput("a", key, "saved-from-a", home); await setProfileInput("a", plain, "public-from-a", home);
  await setProfileInput("a", external, "store-must-lose", home);
  await setProfileInput("b", key, "saved-from-b", home); await setProfileInput("b", external, "store-must-still-lose", home);
  const a = await resolveProfileInputs({ profile: "a", dshHome: home, declarations: [declaration(key), declaration(plain, false), declaration(external)], env: { [external]: "explicit-external", PATH: "/trusted/bin" } });
  assert.deepEqual(JSON.parse(a.env[DSH_HUB_STORED_INPUT_KEYS]!), { v: 1, keys: [plain, key] });
  assert.equal(a.env[DSH_HUB_STORED_INPUT_KEYS]!.includes("saved-"), false);
  const b = await resolveProfileInputs({ profile: "b", dshHome: home, declarations: [declaration(key), declaration(external)], env: a.env });
  assert.equal(b.env[key], "saved-from-b"); assert.equal(b.env[plain], undefined); assert.equal(b.env[external], "explicit-external");
  assert.equal(b.env.PATH, "/trusted/bin"); assert.equal(b.statuses[0]?.source, "stored"); assert.equal(b.statuses[1]?.source, "environment");
  assert.deepEqual(JSON.parse(b.env[DSH_HUB_STORED_INPUT_KEYS]!), { v: 1, keys: [key] });
  assert.equal(a.env[key], "saved-from-a", "resolution never mutates the parent host environment");
  const publicResult = JSON.stringify({ statuses: b.statuses, missing: b.missing });
  for (const privateValue of ["saved-from-a", "saved-from-b", "explicit-external", DSH_HUB_STORED_INPUT_KEYS]) assert.equal(publicResult.includes(privateValue), false);
});

test("only this resolution's stored keys are marked, including empty values and duplicate declarations", async t => {
  const home = await homeFor(t), key = "EMPTY_INPUT";
  await setProfileInput("web", key, "", home);
  const saved = await resolveProfileInputs({ profile: "web", dshHome: home, declarations: [declaration(key), declaration(key)], env: {} });
  assert.deepEqual(JSON.parse(saved.env[DSH_HUB_STORED_INPUT_KEYS]!), { v: 1, keys: [key] });
  assert.deepEqual(saved.statuses.map(item => [item.source, item.configured]), [["stored", false], ["stored", false]]);
  const explicit = await resolveProfileInputs({ profile: "web", dshHome: home, declarations: [declaration(key)], env: { [key]: "" } });
  assert.equal(explicit.statuses[0]?.source, "environment"); assert.equal(explicit.statuses[0]?.configured, false);
  assert.equal(Object.hasOwn(explicit.env, DSH_HUB_STORED_INPUT_KEYS), false);
  const noInputs = await resolveProfileInputs({ profile: "web", dshHome: home, declarations: [], env: saved.env });
  assert.equal(noInputs.env[key], undefined); assert.equal(Object.hasOwn(noInputs.env, DSH_HUB_STORED_INPUT_KEYS), false);
});

test("orphan readiness uses the target store rather than a parent's marked saved value", async t => {
  const home = await homeFor(t), key = "ORPHAN_KEY";
  await setProfileInput("b", key, "", home);
  const statuses = await listProfileInputs({ profile: "b", dshHome: home, env: { [key]: "parent-saved-value", [DSH_HUB_STORED_INPUT_KEYS]: marker([key]) } });
  assert.deepEqual(statuses.map(item => ({ key: item.key, source: item.source, configured: item.configured, declared: item.declared })),
    [{ key, source: "stored", configured: false, declared: false }]);
  const legacy = await listProfileInputs({ profile: "b", dshHome: home, env: { [key]: "unmarked-parent-value" } });
  assert.equal(legacy[0]?.source, "environment"); assert.equal(legacy[0]?.configured, true);
});

test("input-free readiness rejects malformed provenance before reading stores", async t => {
  const home = await homeFor(t), env = { [DSH_HUB_STORED_INPUT_KEYS]: "malformed-private-value" };
  await assert.rejects(resolveProfileInputs({ profile: "web", dshHome: home, declarations: [], env }), /Invalid stored-input environment marker/);
  await assert.rejects(listProfileInputs({ profile: "web", dshHome: home, env }), /Invalid stored-input environment marker/);
});

test("generated provenance exceeding its bound fails rather than launching unmarked saved inputs", async t => {
  const home = await homeFor(t), keys = Array.from({ length: 1025 }, (_, i) => `INPUT_${i}`);
  const inputDirectory = join(home, ".hub", "inputs"); await mkdir(inputDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(inputDirectory, "web.json"), JSON.stringify({ schemaVersion: 1, values: Object.fromEntries(keys.map(key => [key, "synthetic-value"])) }), { mode: 0o600 });
  await assert.rejects(resolveProfileInputs({ profile: "web", dshHome: home, declarations: keys.map(key => declaration(key)), env: {} }), /Invalid stored-input environment marker/);
});

test("Windows external aliases follow Node's lexicographic selection and normalize to one output key", async t => {
  const home = await homeFor(t), key = "SERVICE_KEY";
  await setProfileInput("web", key, "stored-must-lose", home);
  const original = { service_key: "lower-external", Service_Key: "selected-external", Path: "/other/bin", PATH: "/selected/bin" };
  const resolved = await resolveProfileInputs({ profile: "web", dshHome: home, platform: "win32", declarations: [declaration(key), declaration("PATH")], env: original });
  assert.equal(resolved.env[key], "selected-external"); assert.equal(resolved.env.PATH, "/selected/bin");
  assert.deepEqual(resolved.statuses.map(item => [item.source, item.configured]), [["environment", true], ["environment", true]]);
  assert.equal(resolved.env.Service_Key, undefined); assert.equal(resolved.env.service_key, undefined); assert.equal(resolved.env.Path, undefined);
  assert.equal(Object.hasOwn(resolved.env, DSH_HUB_STORED_INPUT_KEYS), false);
  assert.equal(original.Service_Key, "selected-external");
  const orphaned = await listProfileInputs({ profile: "web", dshHome: home, platform: "win32", env: { service_key: "", Service_Key: "" } });
  assert.equal(orphaned[0]?.source, "environment"); assert.equal(orphaned[0]?.configured, false, "empty selected external values remain overrides");
});

test("Windows undefined first alias is absent at spawn and only an actual stored injection is marked", async t => {
  const home = await homeFor(t), key = "SERVICE_KEY";
  await setProfileInput("web", key, "target-stored", home);
  const resolved = await resolveProfileInputs({ profile: "web", dshHome: home, platform: "win32", declarations: [declaration(key)],
    env: { SERVICE_KEY: undefined, Service_Key: "ignored-by-node-spawn" } });
  assert.equal(resolved.env[key], "target-stored"); assert.equal(resolved.env.Service_Key, undefined);
  assert.equal(resolved.statuses[0]?.source, "stored");
  assert.deepEqual(JSON.parse(resolved.env[DSH_HUB_STORED_INPUT_KEYS]!), { v: 1, keys: [key] });
  const nested = await resolveProfileInputs({ profile: "web", dshHome: home, platform: "win32", declarations: [declaration(key)],
    env: { Service_Key: "outer-saved", [DSH_HUB_STORED_INPUT_KEYS]: marker([key]) } });
  assert.equal(nested.env[key], "target-stored"); assert.equal(nested.statuses[0]?.source, "stored");
});

test("POSIX keeps differently cased external input names and provenance removes only the marked name", async t => {
  const home = await homeFor(t), key = "SERVICE_KEY";
  await setProfileInput("web", key, "target-stored", home);
  const resolved = await resolveProfileInputs({ profile: "web", dshHome: home, platform: "linux", declarations: [declaration(key)],
    env: { Service_Key: "separate-external" } });
  assert.equal(resolved.env[key], "target-stored"); assert.equal(resolved.env.Service_Key, "separate-external");
  assert.equal(resolved.statuses[0]?.source, "stored");
  assert.deepEqual(stripStoredInputEnvironment(resolved.env, "linux"), { Service_Key: "separate-external", DSH_HOME: home });
  const orphaned = await listProfileInputs({ profile: "web", dshHome: home, platform: "linux", env: { Service_Key: "separate-external" } });
  assert.equal(orphaned[0]?.source, "stored");
});
