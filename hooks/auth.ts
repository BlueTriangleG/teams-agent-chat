import type { Fetch } from "./graph.ts"

export const SCOPES = "ChannelMessage.Send ChannelMessage.Read.All Team.ReadBasic.All Channel.ReadBasic.All User.ReadBasic.All offline_access"
const SERVICE = "teams-agent-chat"
const EARLY_MS = 5 * 60_000

export type Run = (argv: string[]) => Promise<{ exitCode: number; stdout: string }>
export type SignIn = { userCode: string; link: string; deviceCode: string; intervalS: number; expiresAt: number }
export type Polled = { status: "pending" } | { status: "done"; access: string; refresh: string; expiresAt: number } | { status: "failed"; reason: string }

const login = (tenantId: string, path: string) => `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/${path}`

async function form(fetch: Fetch, url: string, fields: Record<string, string>): Promise<{ status: number; json: any }> {
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() })
    return { status: r.status, json: JSON.parse(r.text || "{}") }
  } catch (err) {
    return { status: 0, json: { error: err instanceof Error ? err.message : String(err) } }
  }
}

export async function startSignIn(fetch: Fetch, tenantId: string, clientId: string, now: number): Promise<SignIn | { failed: string }> {
  const { status, json } = await form(fetch, login(tenantId, "devicecode"), { client_id: clientId, scope: SCOPES })
  if (status >= 300 || !json.device_code) return { failed: String(json.error_description ?? json.error ?? `http ${status}`) }
  return { userCode: json.user_code, link: json.verification_uri, deviceCode: json.device_code, intervalS: Number(json.interval) || 5, expiresAt: now + Number(json.expires_in) * 1000 }
}

function tokensOf(json: any, now: number): Polled {
  return { status: "done", access: json.access_token, refresh: json.refresh_token, expiresAt: now + Number(json.expires_in) * 1000 }
}

export async function pollSignIn(fetch: Fetch, tenantId: string, clientId: string, deviceCode: string, now: number): Promise<Polled> {
  const { json } = await form(fetch, login(tenantId, "token"), {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    client_id: clientId,
    device_code: deviceCode,
  })
  if (json.access_token) return tokensOf(json, now)
  if (json.error === "authorization_pending" || json.error === "slow_down") return { status: "pending" }
  return { status: "failed", reason: String(json.error ?? "unknown") }
}

// `account` names the Keychain item, one per tenant and app.
// `cache` holds the access token between calls, so a caller may build this per call.
// `lapsed`: the last refresh was refused for good (the person must sign in again), as
// opposed to failing for now (no network, an outage), which the next try may get past.
export type TokenCache = { access?: { token: string; expiresAt: number }; lapsed?: boolean }
export function createTokens(fetch: Fetch, run: Run, tenantId: string, clientId: string, account: string, now: () => number = Date.now, cache: TokenCache = {}) {
  const load = async () => {
    const r = await run(["security", "find-generic-password", "-s", SERVICE, "-a", account, "-w"]).catch(() => undefined)
    const token = r?.exitCode === 0 ? r.stdout.trim() : ""
    return token || undefined
  }
  // ponytail: the token is on `security`'s argv for the call's duration, visible to local `ps`; a helper reading stdin if that matters.
  const save = async (refresh: string) => {
    await run(["security", "add-generic-password", "-U", "-s", SERVICE, "-a", account, "-w", refresh])
  }
  return {
    save,
    isSignedIn: async () => (await load()) !== undefined,
    // Signs this session in with a finished device-code sign-in.
    use: async (done: { access: string; refresh: string; expiresAt: number }) => {
      cache.lapsed = false
      cache.access = { token: done.access, expiresAt: done.expiresAt }
      await save(done.refresh)
    },
    get: async (): Promise<string | undefined> => {
      if (cache.access !== undefined && cache.access.expiresAt - EARLY_MS > now()) return cache.access.token
      const refresh = await load()
      if (refresh === undefined) return undefined
      const { json } = await form(fetch, login(tenantId, "token"), { grant_type: "refresh_token", client_id: clientId, refresh_token: refresh, scope: SCOPES })
      if (!json.access_token) {
        cache.access = undefined
        cache.lapsed = json.error === "invalid_grant" || json.error === "interaction_required"
        return undefined
      }
      cache.lapsed = false
      const t = tokensOf(json, now()) as { access: string; refresh: string; expiresAt: number }
      cache.access = { token: t.access, expiresAt: t.expiresAt }
      if (t.refresh) await save(t.refresh)
      return t.access
    },
  }
}

export type Tokens = ReturnType<typeof createTokens>
