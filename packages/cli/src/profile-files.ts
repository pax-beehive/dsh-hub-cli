import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, readlink, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Local-only digest. Never follows symlinks or reads dependency/VCS trees. */
export async function directoryFingerprint(directory: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(path: string, relative: string): Promise<void> {
    let metadata;
    try { metadata = await lstat(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hash.update(JSON.stringify([relative, "missing"]));
      return;
    }
    if (metadata.isSymbolicLink()) {
      hash.update(JSON.stringify([relative, "symlink", await readlink(path)]));
    } else if (metadata.isDirectory()) {
      hash.update(JSON.stringify([relative, "directory"]));
      for (const name of (await readdir(path)).sort()) {
        if (name === "node_modules" || name === ".git") continue;
        await visit(join(path, name), relative ? `${relative}/${name}` : name);
      }
    } else if (metadata.isFile()) {
      const fileHash = createHash("sha256");
      for await (const chunk of createReadStream(path)) fileHash.update(chunk);
      hash.update(JSON.stringify([relative, "file", metadata.mode & 0o777, fileHash.digest("hex")]));
    } else {
      throw new Error(`Unsupported special file in Profile: ${relative}`);
    }
  }
  await visit(directory, "");
  return `sha256:${hash.digest("hex")}`;
}

/** Include the separate Hub state so switching releases invalidates a plan too. */
export async function installationFingerprint(directory: string, statePath: string): Promise<string> {
  return `sha256:${createHash("sha256").update(JSON.stringify([
    await directoryFingerprint(directory), await directoryFingerprint(statePath),
  ])).digest("hex")}`;
}

export async function withProfileMutationLock<T>(statePath: string, action: () => Promise<T>): Promise<T> {
  const path = join(dirname(statePath), "mutation.lock");
  await mkdir(dirname(path), { recursive: true });
  let handle;
  try { handle = await open(path, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("Another Hub operation is modifying this Profile; retry when it completes");
    }
    throw error;
  }
  try { return await action(); }
  finally {
    await handle.close();
    await rm(path, { force: true });
  }
}
