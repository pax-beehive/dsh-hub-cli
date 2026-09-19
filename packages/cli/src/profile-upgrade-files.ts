import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readlink, symlink } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

/** Local-only metadata; link targets must never be printed in previews. */
export interface ProfileFileEntry {
  relativePath: string;
  kind: "file" | "directory" | "symlink";
  mode: number;
  hash: string;
  linkTarget?: string;
}

function digest(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function fail(): never { throw new Error("Profile files changed or cannot be safely preserved; inspect the local files and retry"); }

async function regularFile(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) fail();
    return await handle.readFile();
  } finally { await handle.close(); }
}

/** Includes VCS metadata and empty directories; excludes only root node_modules. Never follows symlinks. */
export async function scanProfileFiles(directory: string): Promise<ProfileFileEntry[]> {
  const entries: ProfileFileEntry[] = [];
  async function visit(relativePath: string): Promise<void> {
    const path = join(directory, relativePath);
    const metadata = await lstat(path);
    const mode = metadata.mode & 0o777;
    if (!relativePath && !metadata.isDirectory()) fail();
    if (metadata.isSymbolicLink()) {
      const linkTarget = await readlink(path);
      entries.push({ relativePath, kind: "symlink", mode, hash: digest(linkTarget), linkTarget });
    } else if (metadata.isDirectory()) {
      entries.push({ relativePath, kind: "directory", mode, hash: digest(`directory:${mode}`) });
      for (const name of (await readdir(path)).sort()) {
        if (!relativePath && name === "node_modules") continue;
        await visit(relativePath ? `${relativePath}/${name}` : name);
      }
    } else if (metadata.isFile()) {
      entries.push({ relativePath, kind: "file", mode, hash: digest(await regularFile(path)) });
    } else fail();
  }
  try { await visit(""); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && entries.length === 0) return [];
    fail();
  }
  return entries;
}

function safePath(root: string, entry: ProfileFileEntry): string {
  const parts = entry.relativePath.split("/");
  if (entry.relativePath && (parts.some(part => !part || part === "." || part === "..") || entry.relativePath.includes("\\"))) fail();
  if (!entry.relativePath && entry.kind !== "directory") fail();
  if (parts[0] === "node_modules") fail();
  const path = resolve(root, entry.relativePath);
  if (path !== resolve(root) && !path.startsWith(`${resolve(root)}${sep}`)) fail();
  return path;
}

async function assertDirectories(root: string, path: string): Promise<void> {
  const relative = path.slice(resolve(root).length);
  let current = resolve(root);
  if (!(await lstat(current)).isDirectory()) fail();
  for (const part of relative.split(sep).filter(Boolean)) {
    current = join(current, part);
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail();
  }
}

/**
 * Copy a prepared snapshot into an isolated staging directory. File contents,
 * symlink text and permissions are rechecked; source/destination symlink parents
 * are rejected. Ordinary files may overwrite a generated stage file. Callers
 * must recheck the whole upgrade context before committing the stage.
 */
export async function copyProfileFiles(source: string, destination: string, entries: ProfileFileEntry[]): Promise<void> {
  const sourceEntries = new Map((await scanProfileFiles(source)).map(entry => [entry.relativePath, entry]));
  const unique = new Set<string>();
  for (const entry of entries) {
    safePath(source, entry); safePath(destination, entry);
    if (unique.has(entry.relativePath) || JSON.stringify(sourceEntries.get(entry.relativePath)) !== JSON.stringify(entry)) fail();
    unique.add(entry.relativePath);
  }
  const directories = entries.filter(entry => entry.kind === "directory").sort((a, b) => a.relativePath.split("/").length - b.relativePath.split("/").length || a.relativePath.localeCompare(b.relativePath));
  try {
    for (const entry of directories) {
      const path = safePath(destination, entry);
      await assertDirectories(destination, entry.relativePath ? dirname(path) : destination);
      try {
        const existing = await lstat(path);
        if (!existing.isDirectory() || existing.isSymbolicLink()) fail();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await mkdir(path, { mode: entry.mode | 0o700 });
      }
    }
    for (const entry of entries.filter(item => item.kind !== "directory")) {
      const from = safePath(source, entry), to = safePath(destination, entry);
      await assertDirectories(source, dirname(from));
      await assertDirectories(destination, dirname(to));
      if (entry.kind === "symlink") {
        if (entry.linkTarget === undefined || await readlink(from) !== entry.linkTarget) fail();
        // Reapplying the same snapshot before/after installation is idempotent;
        // a different link or another file type is never overwritten.
        try {
          const existing = await lstat(to);
          if (!existing.isSymbolicLink() || await readlink(to) !== entry.linkTarget) fail();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await symlink(entry.linkTarget, to);
        }
      } else {
        const contents = await regularFile(from);
        if (digest(contents) !== entry.hash || ((await lstat(from)).mode & 0o777) !== entry.mode) fail();
        const handle = await open(to, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, entry.mode);
        try { await handle.writeFile(contents); await handle.chmod(entry.mode); }
        finally { await handle.close(); }
      }
    }
    for (const entry of directories.reverse()) await chmod(safePath(destination, entry), entry.mode);
  } catch { fail(); }
}
