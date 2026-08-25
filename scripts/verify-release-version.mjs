import { readFile } from "node:fs/promises";

const packagePaths = [
  "package.json",
  "packages/schemas/package.json",
  "packages/registry/package.json",
  "packages/cli/package.json",
  "packages/dsh-plugin/package.json",
];

const manifests = await Promise.all(
  packagePaths.map(async (path) => ({
    path,
    manifest: JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), "utf8")),
  })),
);

const versions = new Set(manifests.map(({ manifest }) => manifest.version));
if (versions.size !== 1) {
  throw new Error(`Package versions must stay in lockstep: ${manifests.map(({ path, manifest }) => `${path}=${manifest.version}`).join(", ")}`);
}

const version = manifests[0].manifest.version;
const tag = process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME;
if (tag && tag !== `v${version}`) {
  throw new Error(`Release tag ${tag} does not match package version ${version}`);
}

console.log(`Release version verified: ${version}`);
