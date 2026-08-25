import {
  hubProfileSchema,
  pluginRecordSchema,
  registrySearchResponseSchema,
  profileSearchResponseSchema,
  type HubProfile,
  profileDraftSchema,
  type ProfileDraft,
  type PluginRecord,
} from "@dsh-plugin-hub/schemas";

export class HubApiClient {
  readonly baseUrl: string;
  readonly accessToken?: () => Promise<string>;

  constructor(baseUrl = "https://api.dshpluginhub.ai/api/v1", accessToken?: () => Promise<string>) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.accessToken = accessToken;
  }

  private async send(path: string, method: "PUT" | "POST", body: unknown): Promise<unknown> {
    const token = await this.accessToken?.();
    if (!token) throw new Error("Hub authentication is required");
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "user-agent": "dsh-hub-cli/0.1",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!response.ok) {
      const detail = text;
      throw new Error(`Hub API ${response.status}: ${detail.slice(0, 500)}`);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`Hub API returned ${response.headers.get("content-type") ?? "an unknown content type"}, expected JSON`);
    }
  }

  private async get(path: string): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: { accept: "application/json", "user-agent": "dsh-hub-cli/0.1" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Hub API ${response.status}: ${detail.slice(0, 300)}`);
    }
    return response.json();
  }

  async search(query: string) {
    const payload = await this.get(`/packages?q=${encodeURIComponent(query)}`);
    return registrySearchResponseSchema.parse(payload);
  }

  async package(packageName: string): Promise<PluginRecord> {
    const payload = await this.get(`/packages/resolve?name=${encodeURIComponent(packageName)}`);
    return pluginRecordSchema.parse(payload);
  }

  async profile(slug: string): Promise<HubProfile> {
    const payload = await this.get(`/profiles/${encodeURIComponent(slug)}`);
    return hubProfileSchema.parse(payload);
  }

  async profiles(query: string) {
    const payload = await this.get(`/profiles?q=${encodeURIComponent(query)}`);
    return profileSearchResponseSchema.parse(payload);
  }

  async saveProfileDraft(draft: ProfileDraft): Promise<ProfileDraft> {
    const payload = await this.send(`/manage/profiles/${encodeURIComponent(draft.slug)}/draft`, "PUT", draft);
    return profileDraftSchema.parse(payload);
  }

  async publishProfile(slug: string, version: string, locallyComposed = false) {
    return this.send(`/manage/profiles/${encodeURIComponent(slug)}/releases`, "POST", {
      version,
      verification: {
        structural: "passed",
        composition: locallyComposed ? "locally_verified" : "local_required",
        activation: "local_required",
        ...(locallyComposed ? { platform: process.platform, verifiedAt: new Date().toISOString() } : {}),
      },
    });
  }
}
