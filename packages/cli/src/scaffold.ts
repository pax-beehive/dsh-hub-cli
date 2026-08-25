import { access, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  dshPackageManifestSchema,
  hubListingSchema,
  npmPackageNameSchema,
} from "@dsh-plugin-hub/schemas";

const starterFiles = ["package.json", "cordis.patch.yml", "README.md"] as const;

export interface PluginStarterOptions {
  directory: string;
  packageName: string;
  repository: string;
  displayName?: string;
}

export interface PluginStarterResult {
  directory: string;
  packageName: string;
  files: string[];
  nextCommands: string[];
}

export async function createPluginStarter(
  options: PluginStarterOptions,
): Promise<PluginStarterResult> {
  const directory = resolve(options.directory);
  const packageName = npmPackageNameSchema.parse(options.packageName.trim());
  const repository = normalizeGitHubRepository(options.repository);
  const displayName = options.displayName?.trim() || humanizePackage(packageName);
  if (!displayName) throw new Error("Display name cannot be empty");
  if (/[\r\n]/.test(displayName)) {
    throw new Error("Display name must fit on one line");
  }
  const entryId = slugifyPackage(packageName);
  const repositoryUrl = `https://github.com/${repository}`;
  const manifest = {
    name: packageName,
    version: "0.1.0",
    description: `${displayName} plugin for DeepSeek Harness.`,
    license: "MIT",
    files: ["cordis.patch.yml", "README.md"],
    repository: {
      type: "git",
      url: `git+${repositoryUrl}.git`,
    },
    homepage: repositoryUrl,
    engines: { node: ">=22" },
    dsh: {
      bundle: { patch: "./cordis.patch.yml" },
      hub: {
        schemaVersion: 1,
        displayName,
        summary: `${displayName} plugin for DeepSeek Harness.`,
        description: `Describe what ${displayName} does and which data it accesses.`,
        homepage: repositoryUrl,
        categories: ["community"],
        keywords: ["deepseek-harness", "dsh", "plugin"],
        compatibility: {
          dsh: ">=0.1.0-rc.7",
          node: ">=22",
          platforms: [],
          surfaces: ["any"],
          hmr: "config",
        },
        entryIds: [entryId],
        before: [],
        after: [],
        channel: "stable",
      },
    },
    publishConfig: { access: "public" },
  } as const;

  dshPackageManifestSchema.parse(manifest);
  hubListingSchema.parse(manifest.dsh.hub);

  const patch = `# DSH bundle patch for ${packageName}\n- insert:\n    - id: ${entryId}\n      name: '${escapeYamlSingleQuoted(displayName)}'\n`;
  const readme = `# ${displayName}\n\n${manifest.description}\n\n## Install\n\n\`\`\`bash\ndsh plugin --profile web add ${packageName}\n\`\`\`\n\n## Publish\n\n1. Edit the description, compatibility and Cordis patch.\n2. Commit and push this directory to [${repository}](${repositoryUrl}).\n3. Run \`npm publish --access public\`.\n4. Sign in to DSH Plugin Hub and enter \`${packageName}\`.\n`;
  const contents = new Map<string, string>([
    ["package.json", `${JSON.stringify(manifest, null, 2)}\n`],
    ["cordis.patch.yml", patch],
    ["README.md", readme],
  ]);

  await mkdir(directory, { recursive: true });
  const existing = await findExistingFiles(directory);
  if (existing.length) {
    throw new Error(`Refusing to overwrite existing starter files: ${existing.join(", ")}`);
  }
  for (const file of starterFiles) {
    await writeFile(resolve(directory, file), contents.get(file)!, {
      encoding: "utf8",
      flag: "wx",
    });
  }

  return {
    directory,
    packageName,
    files: [...starterFiles],
    nextCommands: [
      `cd ${quoteShellArgument(directory)}`,
      "npm pack --dry-run",
      "npm publish --access public",
    ],
  };
}

async function findExistingFiles(directory: string): Promise<string[]> {
  const results = await Promise.all(starterFiles.map(async (file) => {
    try {
      await access(resolve(directory, file));
      return file;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }));
  return results.filter(
    (file): file is (typeof starterFiles)[number] => file !== null,
  );
}

function normalizeGitHubRepository(value: string): string {
  const repository = value.trim()
    .replace(/^https:\/\/github\.com\//i, "")
    .replace(/\.git$/, "")
    .replace(/^\/+|\/+$/g, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("Repository must use the GitHub owner/repository format");
  }
  return repository;
}

function slugifyPackage(packageName: string): string {
  return packageName
    .replace(/^@/, "")
    .replace(/[/. _]+/g, "-")
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function humanizePackage(packageName: string): string {
  const part = packageName.split("/").at(-1) ?? packageName;
  return part
    .replace(/^dsh[-_.]?/i, "")
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((word) => word.slice(0, 1).toUpperCase() + word.slice(1))
    .join(" ") || packageName;
}

function escapeYamlSingleQuoted(value: string): string {
  return value.replaceAll("'", "''");
}

function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
