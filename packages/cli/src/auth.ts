import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { dshHomePath } from "./index.js";

const productionClientId = "client_01M09HAMW290EESBWR59D2EEAP";
const authorizeEndpoint = "https://api.workos.com/user_management/authorize/device";
const tokenEndpoint = "https://api.workos.com/user_management/authenticate";

interface AuthState {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string };
}

interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

function authPath(dshHome?: string): string {
  return join(dshHomePath(dshHome), ".hub", "auth.json");
}

function clientID(): string {
  return process.env.DSH_HUB_WORKOS_CLIENT_ID ?? productionClientId;
}

async function formPost(url: string, values: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(values),
    signal: AbortSignal.timeout(15_000),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function login(options?: {
  dshHome?: string;
  onCode?: (authorization: { code: string; url: string }) => void;
}): Promise<{ id: string; email: string }> {
  const response = await formPost(authorizeEndpoint, { client_id: clientID() });
  if (!response.ok) throw new Error(`WorkOS device authorization failed (${response.status})`);
  const authorization = await response.json() as DeviceAuthorization;
  options?.onCode?.({ code: authorization.user_code, url: authorization.verification_uri_complete });
  let interval = authorization.interval || 5;
  const deadline = Date.now() + authorization.expires_in * 1000;
  while (Date.now() < deadline) {
    const tokenResponse = await formPost(tokenEndpoint, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: authorization.device_code,
      client_id: clientID(),
    });
    const payload = await tokenResponse.json() as Record<string, unknown>;
    if (tokenResponse.ok) {
      const state: AuthState = {
        accessToken: String(payload.access_token),
        refreshToken: String(payload.refresh_token),
        user: payload.user as AuthState["user"],
      };
      const path = authPath(options?.dshHome);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      return state.user;
    }
    if (payload.error === "authorization_pending") await sleep(interval * 1000);
    else if (payload.error === "slow_down") { interval += 1; await sleep(interval * 1000); }
    else throw new Error(`WorkOS authorization failed: ${String(payload.error ?? tokenResponse.status)}`);
  }
  throw new Error("WorkOS authorization timed out");
}

function tokenExpiresSoon(token: string): boolean {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as { exp?: number };
    return !payload.exp || payload.exp <= Math.floor(Date.now() / 1000) + 30;
  } catch { return true; }
}

async function readAuthState(dshHome?: string): Promise<AuthState> {
  try { return JSON.parse(await readFile(authPath(dshHome), "utf8")) as AuthState; }
  catch { throw new Error("Not signed in. Run `dsh-hub login` first."); }
}

export async function getAccessToken(dshHome?: string): Promise<string> {
  const state = await readAuthState(dshHome);
  if (!tokenExpiresSoon(state.accessToken)) return state.accessToken;
  const response = await formPost(tokenEndpoint, {
    grant_type: "refresh_token",
    refresh_token: state.refreshToken,
    client_id: clientID(),
  });
  if (!response.ok) throw new Error("Session expired. Run `dsh-hub login` again.");
  const payload = await response.json() as Record<string, unknown>;
  const next: AuthState = {
    ...state,
    accessToken: String(payload.access_token),
    refreshToken: String(payload.refresh_token ?? state.refreshToken),
  };
  await writeFile(authPath(dshHome), `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return next.accessToken;
}

export async function logout(dshHome?: string): Promise<void> {
  await rm(authPath(dshHome), { force: true });
}
