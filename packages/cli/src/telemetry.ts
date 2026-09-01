import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dshHomePath } from "./index.js";

export const CLI_VERSION = "0.2.0";
export const TELEMETRY_RETENTION_DAYS = 365;

export type CliUsageEvent =
  | "plugin.install"
  | "profile.apply"
  | "profile.upgrade"
  | "profile.rollback"
  | "profile.share"
  | "profile.doctor";

export type CliUsageOutcome = "succeeded" | "failed";

export interface CliUsageInput {
  event: CliUsageEvent;
  outcome: CliUsageOutcome;
  packageName?: string;
  profileSlug?: string;
  version?: string;
  errorCode?: string;
  durationMs?: number;
}

export interface CliUsagePayload extends CliUsageInput {
  durationMs: number;
  platform: NodeJS.Platform;
  architecture: string;
  cliVersion: string;
}

interface SavedTelemetryState {
  schemaVersion: 1;
  enabled: boolean;
  noticeShownAt: string;
}

export interface TelemetryStatus {
  enabled: boolean;
  noticeShown: boolean;
  source: "default-pending-notice" | "saved" | "environment" | "invalid-config";
  configPath: string;
}

let sessionTelemetryEnabled: boolean | undefined;

export function telemetryConfigPath(dshHome?: string): string {
  return join(dshHomePath(dshHome), ".hub", "telemetry.json");
}

function explicitlyDisabled(env: NodeJS.ProcessEnv): boolean {
  const explicit = env.DSH_HUB_TELEMETRY?.trim().toLowerCase();
  return env.DO_NOT_TRACK === "1" || ["0", "false", "off", "no"].includes(explicit ?? "");
}

export function telemetryEnabled(
  env: NodeJS.ProcessEnv = process.env,
  savedEnabled = true,
): boolean {
  return !explicitlyDisabled(env) && savedEnabled;
}

async function readSavedState(dshHome?: string): Promise<{
  state?: SavedTelemetryState;
  invalid: boolean;
}> {
  try {
    const raw = JSON.parse(await readFile(telemetryConfigPath(dshHome), "utf8")) as Partial<SavedTelemetryState>;
    if (raw.schemaVersion !== 1 || typeof raw.enabled !== "boolean" || typeof raw.noticeShownAt !== "string") {
      return { invalid: true };
    }
    return { state: raw as SavedTelemetryState, invalid: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { invalid: false };
    return { invalid: true };
  }
}

async function writeSavedState(state: SavedTelemetryState, dshHome?: string): Promise<void> {
  const path = telemetryConfigPath(dshHome);
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, path);
}

export async function readTelemetryStatus(options?: {
  dshHome?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<TelemetryStatus> {
  const env = options?.env ?? process.env;
  const path = telemetryConfigPath(options?.dshHome);
  const saved = await readSavedState(options?.dshHome);
  if (saved.invalid) {
    return { enabled: false, noticeShown: false, source: "invalid-config", configPath: path };
  }
  if (explicitlyDisabled(env)) {
    return { enabled: false, noticeShown: Boolean(saved.state), source: "environment", configPath: path };
  }
  if (!saved.state) {
    return { enabled: false, noticeShown: false, source: "default-pending-notice", configPath: path };
  }
  return {
    enabled: saved.state.enabled,
    noticeShown: true,
    source: "saved",
    configPath: path,
  };
}

export async function setTelemetryPreference(enabled: boolean, options?: {
  dshHome?: string;
}): Promise<TelemetryStatus> {
  await writeSavedState({
    schemaVersion: 1,
    enabled,
    noticeShownAt: new Date().toISOString(),
  }, options?.dshHome);
  sessionTelemetryEnabled = false;
  return readTelemetryStatus({ dshHome: options?.dshHome, env: {} });
}

export const telemetryNotice = `dsh-hub collects anonymous aggregate CLI usage to improve reliability and prioritise maintenance.
No telemetry is sent during this first-notice run. Future eligible commands report only the public package/Profile name and version, command outcome, stable error category, duration, platform, architecture, and CLI version. No account, machine ID, local path, configuration value, environment value, or secret is included.
Disable before the next run with: dsh-hub telemetry off
Inspect the setting with: dsh-hub telemetry state
Privacy details: https://dshpluginhub.ai/privacy`;

export async function initializeTelemetry(options?: {
  dshHome?: string;
  env?: NodeJS.ProcessEnv;
  onNotice?: (message: string) => void;
  onWarning?: (message: string) => void;
}): Promise<TelemetryStatus> {
  const env = options?.env ?? process.env;
  const status = await readTelemetryStatus({ dshHome: options?.dshHome, env });
  if (status.source === "environment") {
    sessionTelemetryEnabled = false;
    return status;
  }
  if (status.source === "invalid-config") {
    sessionTelemetryEnabled = false;
    options?.onWarning?.(`Telemetry is disabled because ${status.configPath} is invalid.`);
    return status;
  }
  if (!status.noticeShown) {
    sessionTelemetryEnabled = false;
    try {
      await writeSavedState({
        schemaVersion: 1,
        enabled: true,
        noticeShownAt: new Date().toISOString(),
      }, options?.dshHome);
    } catch {
      options?.onWarning?.(`Telemetry remains disabled because ${status.configPath} could not be written.`);
      return { ...status, source: "invalid-config" };
    }
    options?.onNotice?.(telemetryNotice);
    return status;
  }
  sessionTelemetryEnabled = status.enabled;
  return status;
}

export function cliErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/changed after planning/i.test(message)) return "precondition_changed";
  if (/expired/i.test(message)) return "plan_expired";
  if (/missing required local profile inputs/i.test(message)) return "missing_inputs";
  if (/requires pnpm/i.test(message)) return "pnpm_unavailable";
  if (/node\.js >=/i.test(message)) return "node_unsupported";
  if (/version .* has no|no non-yanked version/i.test(message)) return "version_unavailable";
  if (/hub api 401|authentication is required/i.test(message)) return "authentication_required";
  if (/hub api 404|not found/i.test(message)) return "not_found";
  if (/dsh command failed/i.test(message)) return "dsh_command_failed";
  if (/profile.*incomplete/i.test(message)) return "profile_incomplete";
  return "operation_failed";
}

export function buildCliUsagePayload(input: CliUsageInput): CliUsagePayload {
  return {
    ...input,
    durationMs: Math.max(0, Math.min(Math.round(input.durationMs ?? 0), 86_400_000)),
    platform: process.platform,
    architecture: process.arch,
    cliVersion: CLI_VERSION,
  };
}

export function telemetryEndpoint(apiBase: string): string | undefined {
  try {
    const base = new URL(apiBase);
    const local = ["localhost", "127.0.0.1", "::1"].includes(base.hostname);
    if (base.protocol !== "https:" && !(local && base.protocol === "http:")) return undefined;
    return `${apiBase.replace(/\/$/, "")}/telemetry/cli`;
  } catch {
    return undefined;
  }
}

export async function runTelemetryRequest(
  endpoint: string,
  payload: CliUsagePayload,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  try {
    await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": `dsh-hub-cli/${CLI_VERSION}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(1_500),
    });
  } catch {
    // Telemetry is best-effort and cannot change the CLI operation outcome.
  }
}

function spawnTelemetryWorker(endpoint: string, payload: CliUsagePayload): void {
  try {
    const worker = fileURLToPath(new URL("./telemetry-worker.js", import.meta.url));
    const envelope = Buffer.from(JSON.stringify({ endpoint, payload }), "utf8").toString("base64url");
    const child = spawn(process.execPath, [worker, envelope], {
      detached: true,
      stdio: "ignore",
      env: {
        ...(process.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS } : {}),
        ...(process.env.SSL_CERT_FILE ? { SSL_CERT_FILE: process.env.SSL_CERT_FILE } : {}),
        ...(process.env.SSL_CERT_DIR ? { SSL_CERT_DIR: process.env.SSL_CERT_DIR } : {}),
      },
    });
    child.once("error", () => {});
    child.unref();
  } catch {
    // A worker start failure is deliberately invisible to the requested command.
  }
}

export async function sendCliUsage(
  apiBase: string,
  input: CliUsageInput,
  options?: {
    fetchImpl?: typeof fetch;
    env?: NodeJS.ProcessEnv;
    onDebug?: (value: { endpoint: string; payload: CliUsagePayload }) => void;
  },
): Promise<void> {
  const env = options?.env ?? process.env;
  const enabled = options?.fetchImpl
    ? telemetryEnabled(env)
    : sessionTelemetryEnabled ?? telemetryEnabled(env);
  if (!enabled) return;
  const endpoint = telemetryEndpoint(apiBase);
  if (!endpoint) return;
  const payload = buildCliUsagePayload(input);
  if (env.DSH_HUB_TELEMETRY_DEBUG === "1") {
    (options?.onDebug ?? ((value) => process.stderr.write(
      `[dsh-hub telemetry] ${JSON.stringify(value)}\n`,
    )))({ endpoint, payload });
    return;
  }
  if (options?.fetchImpl) {
    await runTelemetryRequest(endpoint, payload, options.fetchImpl);
    return;
  }
  spawnTelemetryWorker(endpoint, payload);
}
