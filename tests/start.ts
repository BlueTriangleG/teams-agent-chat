import { mock } from "claude-code/testing"
import type { TestBody } from "claude-code/testing"

export const OPTIONS = {
  clientId: "app",
  channelLink: "https://teams.microsoft.com/l/channel/19%3Ac%40thread.tacv2/agents?groupId=T1&tenantId=ten",
}
export const BASE = "/home/.claude/teams-agent-chat"
export const T = "mcp__teams-agent-chat__"
const ME = { id: "u-me", displayName: "Gavin" }
const PEOPLE = [{ id: "u-a", displayName: "Alice" }, { id: "u-b", displayName: "Bob" }]

type Msg = { id: string; replyToId?: string; from: { user: { id: string; displayName: string } }; body: { content: string }; createdDateTime: string; mentions?: unknown[] }

// Teams on a map: what the plugin posts lands here, and a test adds what colleagues post.
export function fakeTeams(now: () => number) {
  const roots = new Map<string, Msg>()
  const replies = new Map<string, Msg[]>()
  const posted: { url: string; body: any }[] = []
  const calls: string[] = []
  let n = 0
  let status = 200
  let refuseRefresh = false
  let loginDown = false
  const at = () => new Date(now()).toISOString()
  const ok = (json: unknown, code = 200) => ({ status: code, ok: code < 300, headers: {}, text: JSON.stringify(json) })
  return {
    roots,
    replies,
    posted,
    calls,
    failWith: (code: number) => void (status = code),
    refuseRefresh: (on = true) => void (refuseRefresh = on),
    loginDown: (on = true) => void (loginDown = on),
    colleague: (rootId: string, text: string, who = { id: "u-a", displayName: "Alice" }, mentions: string[] = ["u-me"]) => {
      const m: Msg = { id: `c${++n}`, replyToId: rootId, from: { user: who }, body: { content: text }, createdDateTime: at(), mentions: mentions.map((id) => ({ mentioned: { user: { id } } })) }
      replies.set(rootId, [...(replies.get(rootId) ?? []), m])
      return m.id
    },
    colleagueRoot: (text: string, mentions: string[], who = { id: "u-a", displayName: "Alice" }) => {
      const m: Msg = { id: `cr${++n}`, from: { user: who }, body: { content: text }, createdDateTime: at(), mentions: mentions.map((id) => ({ mentioned: { user: { id } } })) }
      roots.set(m.id, m)
      return m.id
    },
    fetch: async (url: string, init?: { method?: string; body?: string }) => {
      calls.push(`${init?.method ?? "GET"} ${url.replace(/^https:\/\/[^/]+/, "").slice(0, 90)}`)
      if (url.includes("login.microsoftonline.com") && loginDown) return { status: 503, ok: false, headers: {}, text: "" }
      if (url.includes("login.microsoftonline.com"))
        return refuseRefresh ? ok({ error: "invalid_grant" }, 400) : ok({ access_token: "A", refresh_token: "R2", expires_in: 3600 })
      if (status !== 200) return { status, ok: false, headers: status === 429 ? { "retry-after": "30" } : {}, text: "{}" }
      if (url.includes("/me?")) return ok(ME)
      if (url.includes("/users?")) {
        const q = decodeURIComponent(url).match(/startswith\(displayName,'([^']*)'\)/)?.[1] ?? ""
        return ok({ value: PEOPLE.filter((p) => p.displayName.toLowerCase().startsWith(q.toLowerCase())) })
      }
      if (/\/channels\/[^/]+\?\$select=displayName/.test(url)) return ok({ displayName: "agent-chat" })
      const body = init?.body ? JSON.parse(init.body) : undefined
      const reply = url.match(/messages\/([^/?]+)\/replies/)
      if (init?.method === "POST") {
        posted.push({ url, body })
        const m: Msg = { id: `${reply ? "m" : "r"}${++n}`, from: { user: ME }, body: body.body, createdDateTime: at(), mentions: body.mentions }
        if (reply) replies.set(reply[1]!, [...(replies.get(reply[1]!) ?? []), { ...m, replyToId: reply[1]! }])
        else roots.set(m.id, m)
        return ok({ id: m.id }, 201)
      }
      if (reply) return ok({ value: replies.get(decodeURIComponent(reply[1]!)) ?? [] })
      const one = url.match(/messages\/([^/?]+)$/)
      if (one) return roots.has(one[1]!) ? ok(roots.get(one[1]!)) : ok({}, 404)
      return ok({ value: [...roots.values()].reverse() })
    },
  }
}

export type Start = { cwd?: string; sessionId?: string; files?: Record<string, string>; signedIn?: boolean; interactive?: boolean }

export async function start($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], s: Start = {}) {
  const files = new Map<string, string>(Object.entries(s.files ?? {}))
  const submitted: string[] = []
  const notified: string[] = []
  const prompt = { text: "" }
  const keychain = { token: s.signedIn === false ? "" : "R1", reads: 0 }
  mock.env(on, { HOME: "/home" })
  const clock = mock.clock(on)
  const teams = fakeTeams(clock.now)
  on("http.fetch", async (_, e) => ({ value: await teams.fetch(e.url, e.init) }) as never)
  on("process.run", (_, e): never => {
    const argv = e.argv as string[]
    if (argv[1] === "find-generic-password") keychain.reads += 1
    if (argv[1] === "find-generic-password") return { value: keychain.token ? { exitCode: 0, stdout: `${keychain.token}\n`, stderr: "" } : { exitCode: 44, stdout: "", stderr: "" } } as never
    if (argv[1] === "add-generic-password") keychain.token = argv[argv.length - 1] ?? ""
    return { value: { exitCode: 0, stdout: "", stderr: "" } } as never
  })
  on("prompt.read", () => ({ value: { text: prompt.text, cursor: 0 } }))
  on("prompt.submit", (_, e) => (submitted.push(e.text), { text: e.text }))
  on("ui.notify", (_, e) => (notified.push(String((e as { text?: unknown }).text)), { value: { isSent: true, channel: "terminal" } } as never))
  on("model.fork", () => ({ value: { isAnswered: true, text: "working on the orders API, api/orders.ts" } }) as never)
  on("session.id", () => ({ value: s.sessionId ?? "s-me" }))
  on("tool.register", (_, e) => ({ value: { tool: `${T}${e.name}` } }))
  on("fs.write", (_, e) => (files.set(e.path, e.text), { value: undefined }))
  on("fs.read", (_, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on("fs.list", (_, e) => ({
    value: [...files.keys()]
      .filter((p) => p.startsWith(`${e.path}/`) && !p.slice(e.path.length + 1).includes("/"))
      .map((p) => ({ name: p.slice(e.path.length + 1), kind: "file" as const, size: 0, mtimeMs: 0, isLink: false })),
  }))
  // The tool itself, beneath the plugin: SendMessage and the rest just run.
  on("tool.call", () => ({ result: "ran" }))
  on("session.start", (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: s.cwd ?? "/work/web-app", surface: "terminal", isInteractive: s.interactive ?? true })
  const call = async (tool: string, input: Record<string, unknown>) => JSON.stringify(await $.tool.call({ tool: `${T}${tool}`, ...input } as never))
  const typed = (text: string) => $.prompt.submit({ text, origin: { kind: "composer" } } as never)
  return { files, submitted, notified, prompt, clock, teams, keychain, call, typed }
}
