import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ResolvedProfile } from "@dsh-plugin-hub/registry";
import type { HubProfileVersion, ProfileDraft } from "@dsh-plugin-hub/schemas";
import { HubApiClient } from "./api-client.js";
import { getAccessToken } from "./auth.js";
import {
  captureProfile,
  dshHomePath,
  installResolvedProfile,
  listProfileRevisions,
  profileLockPath,
  rollbackProfile,
  validateCurrentProfile,
  type HubLockfile,
} from "./index.js";

interface OperationBase {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  expiresAt: string;
  status: "planned" | "applied";
}

export interface ProfileApplyPlan extends OperationBase {
  kind: "profile.apply";
  precondition: { currentContentHash?: string };
  input: { profile: string; slug: string; release: HubProfileVersion; resolved: ResolvedProfile };
}

export interface ProfileRollbackPlan extends OperationBase {
  kind: "profile.rollback";
  precondition: { currentContentHash?: string };
  input: { profile: string; revision: string; target: HubLockfile };
}

export interface ProfileSharePlan extends OperationBase {
  kind: "profile.share";
  precondition: { localProfileHash: string };
  input: { profile: string; slug: string; version: string; apiBase: string; draft: ProfileDraft };
}

export type OperationPlan = ProfileApplyPlan | ProfileRollbackPlan | ProfileSharePlan;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function profileDraftFingerprint(draft: ProfileDraft): string {
  return `sha256:${createHash("sha256").update(canonical({ ...draft, updatedAt: undefined })).digest("hex")}`;
}

function planPath(id: string, dshHome?: string): string {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error(`Invalid operation plan id: ${id}`);
  return join(dshHomePath(dshHome), ".hub", "operations", `${id}.json`);
}

async function currentState(profile: string, dshHome?: string): Promise<HubLockfile | undefined> {
  try { return JSON.parse(await readFile(profileLockPath(profile, dshHome), "utf8")) as HubLockfile; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function operationBase(): OperationBase {
  const created = new Date();
  return {
    schemaVersion: 1,
    id: randomUUID(),
    createdAt: created.toISOString(),
    expiresAt: new Date(created.getTime() + 30 * 60_000).toISOString(),
    status: "planned",
  };
}

async function persistPlan(plan: OperationPlan, dshHome?: string): Promise<void> {
  const path = planPath(plan.id, dshHome);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(plan, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function createProfileApplyPlan(options: {
  profile: string;
  slug: string;
  release: HubProfileVersion;
  resolved: ResolvedProfile;
  dshHome?: string;
}): Promise<ProfileApplyPlan> {
  const current = await currentState(options.profile, options.dshHome);
  const plan: ProfileApplyPlan = {
    ...operationBase(),
    kind: "profile.apply",
    precondition: { currentContentHash: current?.contentHash },
    input: { profile: options.profile, slug: options.slug, release: options.release, resolved: options.resolved },
  };
  await persistPlan(plan, options.dshHome);
  return plan;
}

export async function createProfileRollbackPlan(options: {
  profile: string;
  revision?: string;
  dshHome?: string;
}): Promise<ProfileRollbackPlan> {
  const current = await currentState(options.profile, options.dshHome);
  const revisions = await listProfileRevisions(options.profile, options.dshHome);
  const selected = options.revision ? revisions.find((item) => item.id === options.revision) : revisions[0];
  if (!selected) throw new Error(`No rollback revision for Profile ${options.profile}`);
  const plan: ProfileRollbackPlan = {
    ...operationBase(),
    kind: "profile.rollback",
    precondition: { currentContentHash: current?.contentHash },
    input: { profile: options.profile, revision: selected.id, target: selected.state },
  };
  await persistPlan(plan, options.dshHome);
  return plan;
}

export async function createProfileSharePlan(options: {
  profile: string;
  slug: string;
  version: string;
  apiBase: string;
  draft: ProfileDraft;
  dshHome?: string;
}): Promise<ProfileSharePlan> {
  const plan: ProfileSharePlan = {
    ...operationBase(),
    kind: "profile.share",
    precondition: { localProfileHash: profileDraftFingerprint(options.draft) },
    input: { profile: options.profile, slug: options.slug, version: options.version, apiBase: options.apiBase, draft: options.draft },
  };
  await persistPlan(plan, options.dshHome);
  return plan;
}

function assertPlan(plan: OperationPlan, id: string): void {
  if (plan.schemaVersion !== 1 || plan.id !== id ||
      !["profile.apply", "profile.rollback", "profile.share"].includes(plan.kind)) {
    throw new Error("Unsupported operation plan");
  }
  if (plan.status !== "planned") throw new Error(`Operation plan is ${plan.status}`);
  if (new Date(plan.expiresAt).getTime() <= Date.now()) throw new Error("Operation plan expired; create a new plan");
}

export async function applyOperationPlan(options: {
  id: string;
  dshHome?: string;
  progress?: (event: Record<string, unknown>) => void;
  install?: typeof installResolvedProfile;
  rollback?: typeof rollbackProfile;
  share?: (input: ProfileSharePlan["input"]) => Promise<unknown>;
}): Promise<{ plan: OperationPlan; revision?: string; publication?: unknown }> {
  const path = planPath(options.id, options.dshHome);
  const lockPath = `${path}.lock`;
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Operation plan is already being applied");
    throw error;
  }
  try {
    const plan = JSON.parse(await readFile(path, "utf8")) as OperationPlan;
    assertPlan(plan, options.id);
    options.progress?.({ type: "operation.started", planId: plan.id, operation: plan.kind });
    let revision: string | undefined;
    let publication: unknown;
    if (plan.kind === "profile.apply") {
      const current = await currentState(plan.input.profile, options.dshHome);
      if (current?.contentHash !== plan.precondition.currentContentHash) {
        throw new Error("Profile changed after planning; create a new plan");
      }
      const result = await (options.install ?? installResolvedProfile)({
        profile: plan.input.profile,
        hubProfileSlug: plan.input.slug,
        release: plan.input.release,
        resolved: plan.input.resolved,
        dshHome: options.dshHome,
      });
      revision = result.revision;
    } else if (plan.kind === "profile.rollback") {
      const current = await currentState(plan.input.profile, options.dshHome);
      if (current?.contentHash !== plan.precondition.currentContentHash) {
        throw new Error("Profile changed after planning; create a new plan");
      }
      const result = await (options.rollback ?? rollbackProfile)({
        profile: plan.input.profile,
        revision: plan.input.revision,
        dshHome: options.dshHome,
      });
      revision = result.restored;
    } else {
      const currentDraft = await captureProfile({
        profile: plan.input.profile,
        slug: plan.input.slug,
        name: plan.input.draft.name,
        description: plan.input.draft.description,
        dsh: plan.input.draft.dsh,
        dshHome: options.dshHome,
      });
      currentDraft.runtime = plan.input.draft.runtime;
      if (profileDraftFingerprint(currentDraft) !== plan.precondition.localProfileHash) {
        throw new Error("Local Profile changed after planning; create a new plan");
      }
      if (options.share) {
        publication = await options.share(plan.input);
      } else {
        await validateCurrentProfile(plan.input.profile);
        const client = new HubApiClient(plan.input.apiBase, getAccessToken);
        await client.saveProfileDraft(plan.input.draft);
        publication = await client.publishProfile(plan.input.slug, plan.input.version, true);
      }
    }
    plan.status = "applied";
    await persistPlan(plan, options.dshHome);
    options.progress?.({ type: "operation.completed", planId: plan.id, operation: plan.kind, revision: revision ?? null });
    return { plan, revision, publication };
  } finally {
    await lock?.close();
    await rm(lockPath, { force: true });
  }
}
