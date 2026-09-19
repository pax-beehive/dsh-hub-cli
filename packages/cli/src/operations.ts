import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ResolvedProfile } from "@dsh-plugin-hub/registry";
import { resolvePluginVersion } from "@dsh-plugin-hub/registry";
import { exactSemverSchema, type HubProfileVersion, type PluginRecord, type ProfileDraft } from "@dsh-plugin-hub/schemas";
import { HubApiClient } from "./api-client.js";
import { getAccessToken } from "./auth.js";
import {
  captureProfile,
  applyProfileEdit,
  prepareLocalProfileRuntime,
  profileNeedsPreservation,
  dshHomePath,
  installResolvedProfile,
  ProfileUpgradeBlockedError,
  listProfileRevisions,
  profileLockPath,
  profileDirectory,
  rollbackProfile,
  validateCurrentProfile,
  type HubLockfile,
} from "./index.js";

import { directoryFingerprint, installationFingerprint } from "./profile-files.js";
import { prepareProfileUpgrade } from "./profile-upgrade.js";
import { prepareProfileEdit, type ProfileEditIntent } from "./profile-edit.js";
import { resolveProfileExportRuntime } from "./profile-lifecycle.js";

export interface ProfileUpgradeResolutions { contextHash: string; choices: Record<string, "local" | "upstream"> }

export async function readUpgradeResolutions(path: string): Promise<ProfileUpgradeResolutions> {
  let parsed: unknown;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 64 * 1024) throw new Error();
    const body = await readFile(path, "utf8");
    if (Buffer.byteLength(body) > 64 * 1024) throw new Error();
    parsed = JSON.parse(body);
  } catch { throw new Error("Cannot read the resolutions file; provide a JSON object under 64 KiB with contextHash and choices"); }
  const input = parsed as Partial<ProfileUpgradeResolutions> | null;
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => key !== "contextHash" && key !== "choices") ||
      typeof input.contextHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(input.contextHash) ||
      !input.choices || typeof input.choices !== "object" || Array.isArray(input.choices) ||
      Object.entries(input.choices).some(([id, choice]) => !id || id.length > 1024 || (choice !== "local" && choice !== "upstream"))) {
    throw new Error("Invalid resolutions file; use the preview contextHash and choices mapping conflict IDs to local or upstream");
  }
  return { contextHash: input.contextHash, choices: { ...input.choices } };
}

interface OperationBase {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  expiresAt: string;
  status: "planned" | "applied";
}

export interface PluginInstallPlan extends OperationBase {
  kind: "plugin.install";
  precondition: { localProfileHash?: string };
  input: {
    profile: string;
    packageName: string;
    version: string;
    installSpec: string;
    security?: PluginRecord["security"];
  };
}

export interface ProfileEditPlan extends OperationBase {
  kind: "profile.edit";
  reviewHash: string;
  precondition: { contextHash: string; resultHash: string };
  effect: { mode: "local-edit"; source: "author" | "local"; previousProfile: "saved_as_revision_if_present"; authorBaseline: "retained" | "not_applicable"; localInputs: "resolved_at_apply_time" };
  input: { profile: string; intent: ProfileEditIntent; runtimeVersion: string; resolutions?: ProfileUpgradeResolutions; security?: PluginRecord["security"] };
}

interface ProfileMutationPlanBase extends OperationBase {
  precondition: { currentContentHash?: string; localProfileHash: string; upgradeContextHash?: string; upgradeResultHash?: string };
  reviewHash: string;
  effect: {
    mode: "replace" | "preserve";
    localChanges: "clean" | "modified" | "unknown";
    previousProfile: "saved_as_revision";
    customizations: "not_merged" | "merged";
    localInputs: "resolved_at_apply_time";
  };
  input: { profile: string; slug: string; release: HubProfileVersion; resolved: ResolvedProfile;
    resolutions?: ProfileUpgradeResolutions; baselineRelease?: HubProfileVersion; baselineResolved?: ResolvedProfile };
}

export interface ProfileApplyOperationPlan extends ProfileMutationPlanBase {
  kind: "profile.apply";
}

export interface ProfileUpgradePlan extends ProfileMutationPlanBase {
  kind: "profile.upgrade";
}

export type ProfileApplyPlan = ProfileApplyOperationPlan | ProfileUpgradePlan;

export interface ProfileRollbackPlan extends OperationBase {
  kind: "profile.rollback";
  precondition: { currentContentHash?: string; localProfileHash: string; revisionHash: string };
  input: { profile: string; revision: string; target: HubLockfile };
}

export interface ProfileSharePlan extends OperationBase {
  kind: "profile.share";
  reviewHash: string;
  precondition: { localProfileHash: string; installationHash: string; runtimeVersion: string; runtimeSource: "recorded" | "explicit" };
  input: { profile: string; slug: string; version: string; apiBase: string; draft: ProfileDraft };
}

export type OperationPlan = PluginInstallPlan | ProfileEditPlan | ProfileApplyPlan | ProfileRollbackPlan | ProfileSharePlan;

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

function mutationReviewHash(plan: Pick<ProfileApplyPlan | ProfileEditPlan, "id" | "kind" | "expiresAt" | "precondition" | "effect" | "input">): string {
  return `sha256:${createHash("sha256").update(canonical({ id: plan.id, kind: plan.kind, expiresAt: plan.expiresAt,
    precondition: plan.precondition, effect: plan.effect, input: plan.input })).digest("hex")}`;
}

function shareReviewHash(plan: Pick<ProfileSharePlan, "id" | "kind" | "expiresAt" | "precondition" | "input">): string {
  return `sha256:${createHash("sha256").update(canonical({ id: plan.id, kind: plan.kind, expiresAt: plan.expiresAt,
    precondition: plan.precondition, input: plan.input })).digest("hex")}`;
}

async function captureShareSnapshot(input: ProfileSharePlan["input"], dshHome?: string) {
  const installationHash = await localProfileHash(input.profile, dshHome);
  const runtime = await resolveProfileExportRuntime({ profile: input.profile, runtimeVersion: input.draft.runtime?.version, dshHome });
  const draft = await captureProfile({ profile: input.profile, slug: input.slug, name: input.draft.name,
    description: input.draft.description, dsh: input.draft.dsh, dshHome, runtimeVersion: runtime.version });
  draft.runtime = { ...input.draft.runtime, range: input.draft.runtime?.range ?? draft.dsh, version: runtime.version };
  if (installationHash !== await localProfileHash(input.profile, dshHome)) {
    throw new Error("Profile changed while preparing publication; capture it and create a new share plan");
  }
  return { installationHash, runtime, draft };
}

async function verifyShareSnapshot(plan: ProfileSharePlan, dshHome?: string): Promise<void> {
  const snapshot = await captureShareSnapshot(plan.input, dshHome);
  if (snapshot.installationHash !== plan.precondition.installationHash || snapshot.runtime.version !== plan.precondition.runtimeVersion ||
      snapshot.runtime.source !== plan.precondition.runtimeSource || profileDraftFingerprint(snapshot.draft) !== plan.precondition.localProfileHash) {
    throw new Error("Profile or recorded runtime changed after planning; create a new share plan");
  }
}

function planPath(id: string, dshHome?: string): string {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error(`Invalid operation plan id: ${id}`);
  return join(dshHomePath(dshHome), ".hub", "operations", `${id}.json`);
}

async function currentState(profile: string, dshHome?: string): Promise<HubLockfile | undefined> {
  try { return JSON.parse(await readFile(profileLockPath(profile, dshHome), "utf8")) as HubLockfile; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) throw new Error("Local Profile state is invalid JSON");
    throw error;
  }
}

async function localProfileHash(profile: string, dshHome?: string): Promise<string> {
  return installationFingerprint(profileDirectory(profile, dshHome), profileLockPath(profile, dshHome));
}

function revisionDirectory(profile: string, revision: string, dshHome?: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(revision) || revision === "." || revision === "..") {
    throw new Error("Invalid Profile revision");
  }
  return join(dirname(profileLockPath(profile, dshHome)), "revisions", revision);
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
  kind?: "profile.apply" | "profile.upgrade";
  dshHome?: string;
  resolutions?: ProfileUpgradeResolutions;
  baselineRelease?: HubProfileVersion;
  baselineResolved?: ResolvedProfile;
}): Promise<ProfileApplyPlan> {
  const current = await currentState(options.profile, options.dshHome);
  const preserve = await profileNeedsPreservation(options.profile, options.dshHome);
  const upgrade = preserve ? await prepareProfileUpgrade(options) : undefined;
  if (upgrade && upgrade.status !== "ready") {
    throw new ProfileUpgradeBlockedError(upgrade.summary, upgrade.status === "baseline_required", upgrade.contextHash);
  }
  const plan: ProfileApplyPlan = {
    ...operationBase(),
    kind: options.kind ?? "profile.apply",
    reviewHash: "",
    precondition: { currentContentHash: current?.contentHash,
      localProfileHash: upgrade?.expectedFingerprint ?? await localProfileHash(options.profile, options.dshHome),
      upgradeContextHash: upgrade?.contextHash, upgradeResultHash: upgrade?.resultHash },
    effect: {
      mode: preserve ? "preserve" : "replace",
      localChanges: current?.localFilesHash
        ? current.localFilesHash === await directoryFingerprint(profileDirectory(options.profile, options.dshHome)) ? "clean" : "modified"
        : "unknown",
      previousProfile: "saved_as_revision",
      customizations: preserve ? "merged" : "not_merged",
      localInputs: "resolved_at_apply_time",
    },
    input: { profile: options.profile, slug: options.slug, release: options.release, resolved: options.resolved,
      resolutions: options.resolutions,
      baselineRelease: current?.authorBaseline ? undefined : options.baselineRelease,
      baselineResolved: current?.authorBaseline ? undefined : options.baselineResolved },
  };
  plan.reviewHash = mutationReviewHash(plan);
  await persistPlan(plan, options.dshHome);
  return plan;
}

export async function createPluginInstallPlan(options: {
  profile: string;
  plugin: PluginRecord;
  version: string;
  installSpec: string;
  dshHome?: string;
  runtimeVersion?: string;
}): Promise<ProfileEditPlan> {
  const selected = resolvePluginVersion(options.plugin, options.version);
  if (selected.version !== options.version || selected.source.installSpec !== options.installSpec) {
    throw new Error("Plugin plan requires the selected exact version and source");
  }
  return createProfileEditPlan({ profile: options.profile, dshHome: options.dshHome, runtimeVersion: options.runtimeVersion,
    security: options.plugin.security?.version === selected.version ? options.plugin.security : undefined,
    intent: { kind: "add", rule: { packageName: options.plugin.packageName, version: selected.version,
      before: selected.before, after: selected.after, compatibility: selected.compatibility }, bundle: { packageName: options.plugin.packageName, selector: selected.version, version: selected.version,
      installSpec: selected.source.installSpec, sourceKind: selected.source.kind,
      integrity: selected.source.kind === "npm" ? selected.source.integrity : undefined } } });
}

export async function createProfileEditPlan(options: {
  profile: string; intent: ProfileEditIntent; runtimeVersion?: string; resolutions?: ProfileUpgradeResolutions; dshHome?: string; security?: PluginRecord["security"];
}): Promise<ProfileEditPlan> {
  const intent = options.intent.kind === "configure" ? { ...options.intent, patchFile: resolve(options.intent.patchFile) } : options.intent;
  const prepared = await prepareProfileEdit({ ...options, intent });
  const plan: ProfileEditPlan = {
    ...operationBase(),
    kind: "profile.edit", reviewHash: "",
    precondition: { contextHash: prepared.contextHash, resultHash: prepared.resultHash },
    effect: { mode: "local-edit", source: prepared.source, previousProfile: "saved_as_revision_if_present",
      authorBaseline: prepared.source === "author" ? "retained" : "not_applicable", localInputs: "resolved_at_apply_time" },
    input: { profile: options.profile, intent, runtimeVersion: exactSemverSchema.parse(prepared.runtime?.version), resolutions: options.resolutions, security: options.security },
  };
  plan.reviewHash = mutationReviewHash(plan);
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
    precondition: {
      currentContentHash: current?.contentHash,
      localProfileHash: await localProfileHash(options.profile, options.dshHome),
      revisionHash: await directoryFingerprint(revisionDirectory(options.profile, selected.id, options.dshHome)),
    },
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
  const input = { profile: options.profile, slug: options.slug, version: options.version, apiBase: options.apiBase, draft: options.draft };
  const snapshot = await captureShareSnapshot(input, options.dshHome);
  const draft = { ...options.draft, runtime: snapshot.draft.runtime };
  if (profileDraftFingerprint(draft) !== profileDraftFingerprint(snapshot.draft)) {
    throw new Error("Profile changed while planning publication; capture it and create a new share plan");
  }
  const plan: ProfileSharePlan = {
    ...operationBase(), kind: "profile.share", reviewHash: "",
    precondition: { localProfileHash: profileDraftFingerprint(draft), installationHash: snapshot.installationHash,
      runtimeVersion: snapshot.runtime.version, runtimeSource: snapshot.runtime.source },
    input: { ...input, draft },
  };
  plan.reviewHash = shareReviewHash(plan);
  await persistPlan(plan, options.dshHome);
  return plan;
}

function assertPlan(plan: OperationPlan, id: string): void {
  if (plan.schemaVersion !== 1 || plan.id !== id ||
      !["plugin.install", "profile.edit", "profile.apply", "profile.upgrade", "profile.rollback", "profile.share"].includes(plan.kind)) {
    throw new Error("Unsupported operation plan");
  }
  if (plan.status !== "planned") throw new Error(`Operation plan is ${plan.status}`);
  if (plan.kind === "plugin.install") throw new Error("This plugin install plan predates atomic local edits; create a new install --plan");
  if (plan.kind === "profile.edit" && !exactSemverSchema.safeParse(plan.input.runtimeVersion).success) {
    throw new Error("This Profile edit plan has no exact runtime selection; create a new plan");
  }
  if (plan.kind === "profile.share" && (!plan.reviewHash || !plan.precondition.installationHash ||
      !exactSemverSchema.safeParse(plan.precondition.runtimeVersion).success ||
      !["recorded", "explicit"].includes(plan.precondition.runtimeSource))) {
    throw new Error("This share plan predates runtime and filesystem binding; create a new share plan");
  }
  if (new Date(plan.expiresAt).getTime() <= Date.now()) throw new Error("Operation plan expired; create a new plan");
}

export async function applyOperationPlan(options: {
  id: string;
  dshHome?: string;
  progress?: (event: Record<string, unknown>) => void;
  install?: typeof installResolvedProfile;
  edit?: typeof applyProfileEdit;
  rollback?: typeof rollbackProfile;
  share?: (input: ProfileSharePlan["input"]) => Promise<unknown>;
  installPlugin?: (input: PluginInstallPlan["input"]) => Promise<void>;
}): Promise<{ plan: OperationPlan; revision?: string; publication?: unknown;
  upgrade?: Awaited<ReturnType<typeof prepareProfileUpgrade>>["summary"];
  edit?: Awaited<ReturnType<typeof prepareProfileEdit>>["summary"] }> {
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
    const addition = plan.kind === "profile.edit" && plan.input.intent.kind === "add" ? plan.input.intent.bundle : undefined;
    options.progress?.({
      type: "operation.started",
      planId: plan.id,
      operation: plan.kind,
      action: plan.kind === "profile.edit" ? plan.input.intent.kind : undefined,
      packageName: plan.kind === "plugin.install" ? plan.input.packageName : addition?.packageName,
      profileSlug: plan.kind === "profile.apply" || plan.kind === "profile.upgrade" || plan.kind === "profile.share" ? plan.input.slug :
        plan.kind === "profile.rollback" ? plan.input.target.hubProfile?.slug : undefined,
      version: plan.kind === "plugin.install" ? plan.input.version :
        plan.kind === "profile.apply" || plan.kind === "profile.upgrade" ? plan.input.release.version :
          plan.kind === "profile.share" ? plan.input.version : plan.kind === "profile.rollback" ? plan.input.target.hubProfile?.version : addition?.version,
    });
    let revision: string | undefined;
    let publication: unknown;
    let upgrade: Awaited<ReturnType<typeof prepareProfileUpgrade>>["summary"] | undefined;
    let edit: Awaited<ReturnType<typeof prepareProfileEdit>>["summary"] | undefined;
    if (plan.kind === "plugin.install") {
      throw new Error("This plugin install plan predates atomic local edits; create a new install --plan");
    } else if (plan.kind === "profile.edit") {
      if (!plan.reviewHash || plan.reviewHash !== mutationReviewHash(plan)) {
        throw new Error("Profile edit plan changed after review; create a new plan");
      }
      await prepareLocalProfileRuntime({ ...plan.input, dshHome: options.dshHome });
      const prepared = await prepareProfileEdit({ ...plan.input, dshHome: options.dshHome });
      if (prepared.contextHash !== plan.precondition.contextHash || prepared.resultHash !== plan.precondition.resultHash) {
        throw new Error("Profile edit changed after planning; create a new plan");
      }
      const result = await (options.edit ?? applyProfileEdit)({ ...plan.input, dshHome: options.dshHome,
        expectedContextHash: plan.precondition.contextHash, expectedResultHash: plan.precondition.resultHash });
      revision = result.revision;
      edit = result.edit;
    } else if (plan.kind === "profile.apply" || plan.kind === "profile.upgrade") {
      const current = await currentState(plan.input.profile, options.dshHome);
      if (!plan.precondition.localProfileHash || current?.contentHash !== plan.precondition.currentContentHash ||
          await localProfileHash(plan.input.profile, options.dshHome) !== plan.precondition.localProfileHash) {
        throw new Error("Preset changed after planning; create a new plan");
      }
      const preserve = await profileNeedsPreservation(plan.input.profile, options.dshHome);
      if (!plan.reviewHash || mutationReviewHash(plan) !== plan.reviewHash ||
          (preserve && (plan.effect?.mode !== "preserve" || !plan.precondition.upgradeContextHash || !plan.precondition.upgradeResultHash))) {
        throw new Error("This Profile mutation plan predates preservation or changed after review; create a new plan");
      }
      if (preserve) {
        const prepared = await prepareProfileUpgrade({ ...plan.input, dshHome: options.dshHome });
        if (prepared.status !== "ready" || prepared.contextHash !== plan.precondition.upgradeContextHash ||
            prepared.resultHash !== plan.precondition.upgradeResultHash) {
          throw new Error("Profile upgrade preparation changed after review; preview and create a new plan");
        }
      }
      const result = await (options.install ?? installResolvedProfile)({
        profile: plan.input.profile,
        hubProfileSlug: plan.input.slug,
        release: plan.input.release,
        resolved: plan.input.resolved,
        dshHome: options.dshHome,
        expectedFingerprint: plan.precondition.localProfileHash,
        mode: preserve ? "upgrade" : "apply",
        resolutions: plan.input.resolutions,
        baselineRelease: plan.input.baselineRelease,
        baselineResolved: plan.input.baselineResolved,
        expectedUpgradeHash: plan.precondition.upgradeResultHash,
      });
      revision = result.revision;
      upgrade = result.upgrade;
    } else if (plan.kind === "profile.rollback") {
      const current = await currentState(plan.input.profile, options.dshHome);
      if (!plan.precondition.localProfileHash || current?.contentHash !== plan.precondition.currentContentHash ||
          await localProfileHash(plan.input.profile, options.dshHome) !== plan.precondition.localProfileHash) {
        throw new Error("Preset changed after planning; create a new plan");
      }
      if (!plan.precondition.revisionHash || await directoryFingerprint(
        revisionDirectory(plan.input.profile, plan.input.revision, options.dshHome),
      ) !== plan.precondition.revisionHash) {
        throw new Error("Rollback revision changed after planning; create a new plan");
      }
      const result = await (options.rollback ?? rollbackProfile)({
        profile: plan.input.profile,
        revision: plan.input.revision,
        dshHome: options.dshHome,
        expectedFingerprint: plan.precondition.localProfileHash,
        expectedRevisionFingerprint: plan.precondition.revisionHash,
      });
      revision = result.restored;
    } else {
      if (shareReviewHash(plan) !== plan.reviewHash) throw new Error("Share plan changed after review; create a new share plan");
      await verifyShareSnapshot(plan, options.dshHome);
      if (options.share) {
        publication = await options.share(plan.input);
      } else {
        await validateCurrentProfile(plan.input.profile, plan.precondition.runtimeVersion, undefined,
          { dshHome: options.dshHome, inputs: plan.input.draft.inputs });
        await verifyShareSnapshot(plan, options.dshHome);
        const client = new HubApiClient(plan.input.apiBase, getAccessToken);
        await client.saveProfileDraft(plan.input.draft);
        await verifyShareSnapshot(plan, options.dshHome);
        publication = await client.publishProfile(plan.input.slug, plan.input.version, true);
      }
    }
    plan.status = "applied";
    await persistPlan(plan, options.dshHome);
    options.progress?.({ type: "operation.completed", planId: plan.id, operation: plan.kind, revision: revision ?? null, upgrade, edit });
    return { plan, revision, publication, upgrade, edit };
  } finally {
    await lock?.close();
    await rm(lockPath, { force: true });
  }
}
