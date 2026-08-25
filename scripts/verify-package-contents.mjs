import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packages = ["schemas", "registry", "cli", "dsh-plugin"];
const forbidden = /(^|\/)(\.env(?:\.|$)|node_modules|src|tests)(\/|$)/;
const npmCache = mkdtempSync(join(tmpdir(), "dsh-hub-npm-cache-"));

try {
  for (const name of packages) {
    const cwd = new URL(`../packages/${name}/`, import.meta.url);
    const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: npmCache },
    });
    if (result.status !== 0) {
      throw new Error(`npm pack failed for ${name}: ${result.stderr || result.stdout}`);
    }
    const report = JSON.parse(result.stdout)[0];
    const files = report.files.map((entry) => entry.path);
    for (const required of ["package.json", "README.md", "LICENSE"]) {
      if (!files.includes(required)) throw new Error(`${name} package is missing ${required}`);
    }
    const leaked = files.filter((path) => forbidden.test(path));
    if (leaked.length) throw new Error(`${name} package contains forbidden files: ${leaked.join(", ")}`);
    console.log(`${report.name}@${report.version}: ${files.length} files, ${report.size} bytes`);
  }
} finally {
  rmSync(npmCache, { recursive: true, force: true });
}
