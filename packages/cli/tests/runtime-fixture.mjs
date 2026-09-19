import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Real subprocess fixture: records preparation env and materializes an executable package. */
export async function fakeRuntimeInstaller(root, runtimeScript, keys = []) {
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "npm"), `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2); const prefix = args[args.indexOf('--prefix') + 1];
const version = args.at(-1).slice('@deepseek-ai/dsh@'.length);
const values = Object.fromEntries(${JSON.stringify(keys)}.map(key => [key, process.env[key]]));
fs.writeFileSync(path.join(process.env.DSH_HOME, 'prepare.json'), JSON.stringify({args, values}));
const pkg = path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh');
fs.mkdirSync(pkg, {recursive:true});
fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({name:'@deepseek-ai/dsh',version,bin:{dsh:'bin.cjs'}}));
fs.writeFileSync(path.join(pkg, 'bin.cjs'), ${JSON.stringify(runtimeScript)});
`, { mode: 0o700 });
  return bin;
}
