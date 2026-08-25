import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { hubProfileVersionSchema, type HubProfileVersion } from "@dsh-plugin-hub/schemas";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function verifyProfileRelease(release: HubProfileVersion): void {
  if (!release.contentHash) return;
  const unsigned = { ...release, contentHash: undefined };
  const actual = `sha256:${createHash("sha256").update(canonical(unsigned)).digest("hex")}`;
  if (actual !== release.contentHash) {
    throw new Error(`Profile Release content hash mismatch: expected ${release.contentHash}, got ${actual}`);
  }
}

function unzipEntry(archive: Buffer, wanted: string): Buffer | undefined {
  let eocd = -1;
  for (let index = archive.length - 22; index >= Math.max(0, archive.length - 65_557); index -= 1) {
    if (archive.readUInt32LE(index) === 0x06054b50) { eocd = index; break; }
  }
  if (eocd < 0) throw new Error("Invalid .dshprofile ZIP: end record not found");
  const count = archive.readUInt16LE(eocd + 10);
  if (count > 32) throw new Error("Invalid .dshprofile ZIP: too many entries");
  let offset = archive.readUInt32LE(eocd + 16);
  for (let index = 0; index < count; index += 1) {
    if (offset < 0 || offset + 46 > eocd) throw new Error("Invalid .dshprofile ZIP directory bounds");
    if (archive.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid .dshprofile ZIP directory");
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    if (offset + 46 + nameLength + extraLength + commentLength > eocd) {
      throw new Error("Invalid .dshprofile ZIP directory entry bounds");
    }
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (uncompressedSize > 2_000_000) throw new Error(`Archive entry ${name} is too large`);
    if (compressedSize > archive.length || localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error("Invalid .dshprofile ZIP entry");
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    if (start + compressedSize > archive.length) throw new Error(`Corrupt archive entry ${name}`);
    if (name === wanted) {
      const compressed = archive.subarray(start, start + compressedSize);
      const body = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : undefined;
      if (!body || body.length !== uncompressedSize) throw new Error(`Unsupported or corrupt archive entry ${name}`);
      return body;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return undefined;
}

export async function readProfileArchive(path: string): Promise<HubProfileVersion> {
  const archive = await readFile(path);
  if (archive.length > 5_000_000) throw new Error(".dshprofile archive is too large");
  const releaseJSON = unzipEntry(archive, "release.json");
  if (!releaseJSON) throw new Error(".dshprofile is missing release.json");
  const release = hubProfileVersionSchema.parse(JSON.parse(releaseJSON.toString("utf8")));
  if (!release.contentHash) throw new Error(".dshprofile release has no content hash");
  verifyProfileRelease(release);
  return release;
}
