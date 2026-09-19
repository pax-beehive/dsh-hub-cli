import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { copyProfileFiles, scanProfileFiles } from "../dist/profile-upgrade-files.js";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "dsh-file-preserve-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source"), destination = join(root, "stage");
  await mkdir(source); await mkdir(destination);
  return { root, source, destination };
}

test("copies file modes, hidden VCS, empty directories and symlink text without reading link targets", async t => {
  const { source, destination } = await fixture(t);
  await mkdir(join(source, ".git")); await writeFile(join(source, ".git", "config"), "private");
  await mkdir(join(source, "empty")); await chmod(join(source, "empty"), 0o750);
  await writeFile(join(source, "script"), "private script"); await chmod(join(source, "script"), 0o751);
  await symlink("/absent/external-target", join(source, "external"));
  await mkdir(join(source, "node_modules")); await writeFile(join(source, "node_modules", "ignored"), "dependency");
  const files = await scanProfileFiles(source);
  assert.equal(files.some(item => item.relativePath.includes("node_modules")), false);
  await copyProfileFiles(source, destination, files);
  await copyProfileFiles(source, destination, files);
  assert.equal(await readFile(join(destination, ".git", "config"), "utf8"), "private");
  assert.equal((await lstat(join(destination, "script"))).mode & 0o777, 0o751);
  assert.equal((await lstat(join(destination, "empty"))).mode & 0o777, 0o750);
  assert.equal(await readlink(join(destination, "external")), "/absent/external-target");
  assert.deepEqual(await scanProfileFiles(destination), files);
});

test("a conflicting destination symlink is never retargeted", async t => {
  const { source, destination } = await fixture(t);
  await symlink("original-local-target", join(source, "link"));
  await symlink("different-stage-target", join(destination, "link"));
  await assert.rejects(copyProfileFiles(source, destination, await scanProfileFiles(source)));
  assert.equal(await readlink(join(destination, "link")), "different-stage-target");
});

test("snapshot changes abort before copying", async t => {
  const { source, destination } = await fixture(t);
  await writeFile(join(source, "note"), "reviewed");
  const files = await scanProfileFiles(source);
  await writeFile(join(source, "note"), "changed");
  await assert.rejects(copyProfileFiles(source, destination, files), /changed or cannot be safely preserved/);
  assert.deepEqual((await scanProfileFiles(destination)).map(item => item.relativePath), [""]);
});

test("destination symlinks cannot redirect writes outside staging", async t => {
  const { root, source, destination } = await fixture(t);
  const outside = join(root, "outside"); await writeFile(outside, "original");
  await writeFile(join(source, "note"), "new");
  await symlink(outside, join(destination, "note"));
  await assert.rejects(copyProfileFiles(source, destination, await scanProfileFiles(source)), /changed or cannot be safely preserved/);
  assert.equal(await readFile(outside, "utf8"), "original");
});

test("destination directory symlinks and crafted traversal entries are rejected", async t => {
  const { root, source, destination } = await fixture(t);
  await mkdir(join(source, "notes")); await writeFile(join(source, "notes", "one"), "new");
  const outside = join(root, "outside"); await mkdir(outside); await symlink(outside, join(destination, "notes"));
  const files = await scanProfileFiles(source);
  await assert.rejects(copyProfileFiles(source, destination, files));
  await assert.rejects(copyProfileFiles(source, destination, [{ ...files[0]!, relativePath: "../outside" }]));
  assert.deepEqual((await scanProfileFiles(outside)).map(item => item.relativePath), [""]);
});

test("a missing source scans empty and root symlinks are refused", async t => {
  const { root, source } = await fixture(t);
  assert.deepEqual(await scanProfileFiles(join(root, "missing")), []);
  await symlink(source, join(root, "linked"));
  await assert.rejects(scanProfileFiles(join(root, "linked")), /cannot be safely preserved/);
});
