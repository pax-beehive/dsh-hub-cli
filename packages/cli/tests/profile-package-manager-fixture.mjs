import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Driver fixture only: this digest describes synthetic fixture bytes. These
// tests exercise orchestration and never claim real package integrity evidence.
export const fakeProfilePackageIntegrity = `sha512-${createHash("sha512").update("fixture").digest("base64")}`;

/** Install an exact local pnpm driver without invoking a real package manager. */
export async function installFakeProfilePackageManager(dshHome, options = {}) {
  const directory = join(dshHome, ".hub", "package-managers", "pnpm", "10.33.0", "node_modules", "pnpm");
  await mkdir(join(directory, "bin"), { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "pnpm", version: "10.33.0", bin: { pnpm: "bin/pnpm.cjs" } }));
  const settings = JSON.stringify({ integrity: fakeProfilePackageIntegrity, ...options });
  await writeFile(join(directory, "bin", "pnpm.cjs"), `const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const settings = ${settings};
const args = process.argv.slice(2);
function record(phase) {
  if (!settings.eventFile) return;
  const event = { phase, args };
  for (const [field, key] of Object.entries(settings.recordFields ?? {})) event[field] = process.env[key];
  fs.appendFileSync(settings.eventFile, JSON.stringify(event) + '\\n');
}
if (args.includes('--version')) { console.log('10.33.0'); process.exit(0); }
if (args[0] === 'config' && args[1] === 'list' && args.includes('--json')) {
  record('pm-config'); console.log('{}'); process.exit(0);
}
if (args[0] !== 'install') throw new Error('Unexpected fixture pnpm command');
const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
const fields = ['dependencies', 'devDependencies', 'optionalDependencies'];
const lock = { lockfileVersion: '9.0', settings: { autoInstallPeers: true, excludeLinksFromLockfile: false }, importers: { '.': {} }, packages: {}, snapshots: {} };
for (const field of fields) {
  const dependencies = Object.entries(manifest[field] ?? {});
  if (!dependencies.length) continue;
  const importer = lock.importers['.'][field] = {};
  for (const [name, version] of dependencies) {
    if (typeof version !== 'string' || !/^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Fixture only supports exact npm dependency versions');
    importer[name] = { specifier: version, version };
    const key = name + '@' + version;
    lock.packages[key] = { resolution: { integrity: settings.integrity } };
    lock.snapshots[key] = {};
  }
}
if (args.includes('--lockfile-only') && args.includes('--ignore-scripts')) {
  record('pm-resolution');
  // JSON is valid YAML and keeps the synthetic native v9 graph unambiguous.
  fs.writeFileSync(path.join(process.cwd(), 'pnpm-lock.yaml'), JSON.stringify(lock, null, 2) + '\\n');
  process.exit(0);
}
if (!args.includes('--frozen-lockfile')) throw new Error('Unexpected fixture installation phase');
record('pm-install');
for (const field of fields) for (const [name, version] of Object.entries(manifest[field] ?? {})) {
  const dependency = path.join(process.cwd(), 'node_modules', ...name.split('/'));
  fs.mkdirSync(dependency, { recursive: true });
  fs.writeFileSync(path.join(dependency, 'package.json'), JSON.stringify({ name, version, dsh: { bundle: { patch: 'patch.yml' } } }));
  fs.writeFileSync(path.join(dependency, 'patch.yml'), '[]\\n');
}
if (settings.lifecycleScript) {
  const child = spawnSync(process.execPath, [settings.lifecycleScript, ...args], { env: process.env, stdio: 'inherit' });
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}
`);
}
