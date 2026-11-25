import type { HttpInit, HttpResponse } from "claude-code"

import type { Place } from "./link.ts"
import type { Person, Post } from "./threads.ts"

export type Fetch = (url: string, init?: HttpInit) => Promise<HttpResponse>
export type Got<T> = { ok: true; value: T } | { ok: false; reason: "auth" | "rate" | "http"; status: number; retryAfterS?: number }
export type Body = { body: { contentType: "html"; content: string }; mentions: unknown[] }

const GRAPH = "https://graph.microsoft.com/v1.0"

function escaped(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>")
}

export function bodyOf(tag: string, to: Person, text: string): Body {
  return {
    body: { contentType: "html", content: `${tag} <at id="0">${escaped(to.name)}</at> ${escaped(text)}` },
    mentions: [{ id: 0, mentionText: to.name, mentioned: { user: { id: to.id, displayName: to.name, userIdentityType: "aadUser" } } }],
  }
}

export function textOf(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim()
}

type Message = {
  id?: string
  replyToId?: string | null
  from?: { user?: { id?: string; displayName?: string } | null } | null
  body?: { content?: string }
  createdDateTime?: string
  mentions?: { mentioned?: { user?: { id?: string } | null } }[]
}

function postOf(m: Message, rootId: string): Post | undefined {
  const user = m.from?.user
  if (!m.id || !user?.id) return undefined
  return { id: m.id, rootId, from: { id: user.id, name: user.displayName ?? "" }, text: textOf(m.body?.content ?? ""), at: Date.parse(m.createdDateTime ?? "") || 0 }
}

export function createGraph(fetch: Fetch, token: () => Promise<string | undefined>, place: Place) {
  const channel = `${GRAPH}/teams/${encodeURIComponent(place.teamId)}/channels/${encodeURIComponent(place.channelId)}/messages`
  const call = async <T>(url: string, read: (json: any) => T, body?: unknown): Promise<Got<T>> => {
    const t = await token()
    if (t === undefined) return { ok: false, reason: "auth", status: 401 }
    let r: HttpResponse
    try {
      r = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${t}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch {
      return { ok: false, reason: "http", status: 0 }
    }
    if (r.status === 401) return { ok: false, reason: "auth", status: 401 }
    if (r.status === 429) {
      const after = Number(r.headers["retry-after"] ?? r.headers["Retry-After"])
      return { ok: false, reason: "rate", status: 429, retryAfterS: Number.isFinite(after) && after > 0 ? after : 30 }
    }
    if (r.status >= 300) return { ok: false, reason: "http", status: r.status }
    try {
      return { ok: true, value: read(JSON.parse(r.text || "{}")) }
    } catch {
      return { ok: false, reason: "http", status: r.status }
    }
  }
  const people = (json: any): Person[] =>
    ((json.value ?? []) as { id?: string; displayName?: string }[]).filter((u) => u.id).map((u) => ({ id: u.id!, name: u.displayName ?? "" }))
  return {
    me: () => call(`${GRAPH}/me?$select=id,displayName`, (j) => ({ id: String(j.id), name: String(j.displayName ?? "") })),
    findUser: (query: string) => {
      const q = query.trim().replace(/'/g, "''")
      const filter = encodeURIComponent(`startswith(displayName,'${q}') or startswith(mail,'${q}')`)
      return call(`${GRAPH}/users?$filter=${filter}&$select=id,displayName,mail&$top=5`, people)
    },
    postRoot: (b: Body) => call(channel, (j) => String(j.id), b),
    postReply: (rootId: string, b: Body) => call(`${channel}/${encodeURIComponent(rootId)}/replies`, (j) => String(j.id), b),
    root: (rootId: string) => call(`${channel}/${encodeURIComponent(rootId)}`, (j) => postOf(j as Message, rootId)),
    replies: (rootId: string) =>
      call(`${channel}/${encodeURIComponent(rootId)}/replies?$top=50`, (j) =>
        ((j.value ?? []) as Message[]).flatMap((m) => postOf(m, rootId) ?? []).sort((a, b) => a.at - b.at),
      ),
    // The newest root posts, with whom each @mentions.
    roots: () =>
      call(`${channel}?$top=20`, (j) =>
        ((j.value ?? []) as Message[]).flatMap((m) => {
          const p = postOf(m, m.id ?? "")
          return p === undefined ? [] : [{ ...p, mentions: (m.mentions ?? []).flatMap((x) => x.mentioned?.user?.id ?? []) }]
        }),
      ),
  }
}

export type Graph = ReturnType<typeof createGraph>
