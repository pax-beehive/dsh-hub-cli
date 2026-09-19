import assert from "node:assert/strict";
import test from "node:test";
import { mergeProfileJson, type ProfileJsonObject, type ProfileJsonValue } from "../src/profile-merge.ts";

function resolved(base: ProfileJsonValue | undefined, local: ProfileJsonValue | undefined, upstream: ProfileJsonValue | undefined) {
  const result = mergeProfileJson(base, local, upstream);
  assert.equal(result.status, "resolved");
  if (result.status !== "resolved") throw new Error("Expected a resolved merge");
  assert.deepEqual(result.conflicts, []);
  return result.value;
}

test("package manifests retain a local dependency while the author updates another", () => {
  const base = { private: true, dependencies: { "dsh-core": "1.0.0", "dsh-search": "2.0.0" } };
  const local = { ...base, dependencies: { ...base.dependencies, "dsh-local": "3.0.0" } };
  const upstream = { ...base, dependencies: { ...base.dependencies, "dsh-core": "1.1.0" } };
  assert.deepEqual(resolved(base, local, upstream), {
    private: true, dependencies: { "dsh-core": "1.1.0", "dsh-search": "2.0.0", "dsh-local": "3.0.0" },
  });
});

test("incompatible edits to the same dependency require explicit resolution", () => {
  const result = mergeProfileJson({ dependencies: { plugin: "1.0.0" } },
    { dependencies: { plugin: "github:me/plugin#local" }, description: "local" },
    { dependencies: { plugin: "2.0.0" }, license: "MIT" });
  assert.deepEqual(result, { status: "conflicted", conflicts: [{
    path: "/dependencies/plugin", base: { present: true, value: "1.0.0" },
    local: { present: true, value: "github:me/plugin#local" }, upstream: { present: true, value: "2.0.0" },
  }] });
  assert.equal(Object.hasOwn(result, "value"), false, "a partially merged manifest must not be installable");
});

test("identical concurrent edits resolve, including property removal and root deletion", () => {
  assert.deepEqual(resolved({ a: 1, removed: true }, { a: 2 }, { a: 2 }), { a: 2 });
  assert.equal(resolved({ a: 1 }, undefined, undefined), undefined);
  assert.equal(resolved("old", "new", "new"), "new");
});

test("unchanged local accepts upstream and unchanged upstream retains local", () => {
  assert.deepEqual(resolved({ settings: { a: 1 } }, { settings: { a: 1 } }, { settings: { a: 2 } }), { settings: { a: 2 } });
  assert.deepEqual(resolved({ settings: { a: 1 } }, { settings: { a: 2 } }, { settings: { a: 1 } }), { settings: { a: 2 } });
});

test("structured configuration merges independent nested settings and deletions", () => {
  const base = { model: { temperature: 0.5, obsolete: true }, ui: { theme: "light", compact: false } };
  const local = { model: { temperature: 0.5 }, ui: { theme: "dark", compact: false } };
  const upstream = { model: { temperature: 0.7, obsolete: true }, ui: { theme: "light", compact: true } };
  assert.deepEqual(resolved(base, local, upstream), { model: { temperature: 0.7 }, ui: { theme: "dark", compact: true } });
});

test("independently added object properties merge while competing leaf additions conflict", () => {
  assert.deepEqual(resolved(undefined, { settings: { local: true } }, { settings: { upstream: true } }), {
    settings: { local: true, upstream: true },
  });
  const result = mergeProfileJson({}, { setting: "local" }, { setting: "upstream" });
  assert.deepEqual(result, { status: "conflicted", conflicts: [{ path: "/setting", base: { present: false },
    local: { present: true, value: "local" }, upstream: { present: true, value: "upstream" } }] });
});

test("deletion versus modification conflicts without silently recreating or removing content", () => {
  const cases: Array<[ProfileJsonObject, ProfileJsonObject]> = [[{}, { settings: { a: 2 } }], [{ settings: { a: 2 } }, {}]];
  for (const [local, upstream] of cases) {
    const result = mergeProfileJson({ settings: { a: 1 } }, local, upstream);
    assert.equal(result.status, "conflicted");
    assert.equal(result.conflicts[0]!.path, "/settings");
    assert.equal(result.conflicts[0]!.local.present, Object.hasOwn(local, "settings"));
    assert.equal(result.conflicts[0]!.upstream.present, Object.hasOwn(upstream, "settings"));
    assert.equal(Object.hasOwn(result, "value"), false);
  }
});

test("missing and JSON null remain distinct at both root and property paths", () => {
  assert.equal(resolved(undefined, null, undefined), null);
  assert.deepEqual(resolved({ a: null }, {}, { a: null }), {});
  assert.deepEqual(mergeProfileJson(null, undefined, 1), { status: "conflicted", conflicts: [{
    path: "", base: { present: true, value: null }, local: { present: false }, upstream: { present: true, value: 1 },
  }] });
  assert.deepEqual(mergeProfileJson({}, { a: null }, { a: false }), { status: "conflicted", conflicts: [{
    path: "/a", base: { present: false }, local: { present: true, value: null }, upstream: { present: true, value: false },
  }] });
});

test("arrays are atomic: conflicting plugin order or Cordis patch edits are not guessed", () => {
  const base = [{ id: "a", value: 1 }, { id: "b", value: 1 }];
  const local = [{ id: "a", value: 2 }, { id: "b", value: 1 }];
  const upstream = [{ id: "a", value: 1 }, { id: "b", value: 2 }];
  const result = mergeProfileJson({ patch: base }, { patch: local }, { patch: upstream });
  assert.equal(result.status, "conflicted");
  assert.deepEqual(result.conflicts.map(item => item.path), ["/patch"]);
  assert.deepEqual(resolved(["a", "b"], ["b", "a"], ["a", "b"]), ["b", "a"]);
  assert.deepEqual(resolved(["a"], ["a", "b"], ["a", "b"]), ["a", "b"]);
});

test("two incompatible replacements of an existing scalar stay a conflict", () => {
  const result = mergeProfileJson({ config: "old" }, { config: { a: 1 } }, { config: { b: 2 } });
  assert.equal(result.status, "conflicted");
  assert.deepEqual(result.conflicts.map(item => item.path), ["/config"]);
});

test("file-hash manifests preserve local additions and deletions with an independent upstream update", () => {
  const base = { "notes.md": "sha256:notes", "settings.json": "sha256:v1", "old.txt": "sha256:old" };
  const local = { "notes.md": "sha256:notes", "settings.json": "sha256:v1", "custom.txt": "sha256:custom" };
  const upstream = { ...base, "settings.json": "sha256:v2" };
  assert.deepEqual(resolved(base, local, upstream), {
    "notes.md": "sha256:notes", "settings.json": "sha256:v2", "custom.txt": "sha256:custom",
  });
});

test("conflicts use stable escaped JSON Pointers independent of input key order", () => {
  const base = { z: "old", "folder/name": { "key~part": 0, "": false } };
  const local = { "folder/name": { "": true, "key~part": 1 }, z: "local" };
  const upstream = { z: "upstream", "folder/name": { "key~part": 2, "": null } };
  const result = mergeProfileJson(base, local, upstream);
  assert.equal(result.status, "conflicted");
  assert.deepEqual(result.conflicts.map(item => item.path), ["/folder~1name/", "/folder~1name/key~0part", "/z"]);
  assert.deepEqual(mergeProfileJson({ "folder/name": base["folder/name"], z: "old" }, local, upstream), result);
});

test("prototype-named keys are ordinary own data and never alter an object prototype", () => {
  const base = JSON.parse('{"__proto__":{"profileMergePolluted":false},"constructor":{"prototype":{"a":1}}}') as ProfileJsonObject;
  const local = JSON.parse('{"__proto__":{"profileMergePolluted":true},"constructor":{"prototype":{"a":1}}}') as ProfileJsonObject;
  const upstream = JSON.parse('{"__proto__":{"profileMergePolluted":false},"constructor":{"prototype":{"a":2}},"toString":"data"}') as ProfileJsonObject;
  const merged = resolved(base, local, upstream) as ProfileJsonObject;
  assert.equal(Object.getPrototypeOf(merged), Object.prototype);
  assert.equal(Object.hasOwn(merged, "__proto__"), true);
  assert.deepEqual(merged.__proto__, { profileMergePolluted: true });
  assert.deepEqual(merged.constructor, { prototype: { a: 2 } });
  assert.equal(merged.toString, "data");
  assert.equal(Object.hasOwn(Object.prototype, "profileMergePolluted"), false);
  assert.equal(Object.hasOwn(Object.prototype, "a"), false);
});

test("resolved values and conflict snapshots do not share mutable input references", () => {
  const shared = { nested: { value: 1 }, items: [{ value: 1 }] };
  const merged = resolved(shared, shared, shared) as typeof shared;
  merged.nested.value = 2;
  merged.items[0]!.value = 2;
  assert.deepEqual(shared, { nested: { value: 1 }, items: [{ value: 1 }] });
  const base = [{ id: "base" }], local = [{ id: "local" }], upstream = [{ id: "upstream" }];
  const result = mergeProfileJson(base, local, upstream);
  assert.equal(result.status, "conflicted");
  for (const item of [result.conflicts[0]!.base, result.conflicts[0]!.local, result.conflicts[0]!.upstream]) {
    assert.equal(item.present, true);
    if (item.present) (item.value as Array<{ id: string }>)[0]!.id = "modified snapshot";
  }
  assert.deepEqual([base, local, upstream], [[{ id: "base" }], [{ id: "local" }], [{ id: "upstream" }]]);
});

test("frozen inputs and records with null prototypes are supported without mutation", () => {
  const base = Object.freeze({ config: Object.freeze({ a: 1, b: 1 }) });
  const local = Object.freeze({ config: Object.freeze({ a: 2, b: 1 }) });
  const upstream = Object.assign(Object.create(null), { config: { a: 1, b: 2 } }) as ProfileJsonObject;
  assert.deepEqual(resolved(base, local, upstream), { config: { a: 2, b: 2 } });
});

test("invalid JSON is rejected without evaluating getters or including input values in errors", () => {
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  let getterRead = false;
  const getter = Object.defineProperty({}, "secret", { enumerable: true, get() { getterRead = true; return "secret-value"; } });
  for (const invalid of [NaN, Infinity, new Date(), cyclic, { secret: undefined }, getter, Array(2)]) {
    assert.throws(() => mergeProfileJson({}, invalid as ProfileJsonValue, {}), {
      name: "TypeError", message: "Profile merge inputs must contain only JSON values",
    });
  }
  assert.equal(getterRead, false);
});
