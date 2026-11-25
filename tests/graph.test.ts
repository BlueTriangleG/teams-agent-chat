import { expect, test } from "claude-code/testing"
import type { HttpInit, HttpResponse } from "claude-code"

import { bodyOf, createGraph, textOf } from "../hooks/graph.ts"

const place = { tenantId: "t", teamId: "T1", channelId: "19:c@thread.tacv2" }
const BASE = "https://graph.microsoft.com/v1.0/teams/T1/channels/19%3Ac%40thread.tacv2/messages"
const alice = { id: "u-a", name: "Alice" }

function fake(answer: (url: string, init?: HttpInit) => Partial<HttpResponse>) {
  const calls: { url: string; init?: HttpInit }[] = []
  const fetch = async (url: string, init?: HttpInit) => {
    calls.push({ url, init })
    const r = answer(url, init)
    const status = r.status ?? 200
    return { status, ok: status < 300, headers: {}, text: "", ...r } as HttpResponse
  }
  return { calls, graph: createGraph(fetch, async () => "tok", place) }
}

test("a post escapes its text and @mentions the other side", async () => {
  const b = bodyOf("🤖 [Gavin 的 Claude]", alice, "if (a < b && c) {}\nnext")
  expect(b.body.contentType).toBe("html")
  expect(b.body.content).toBe('🤖 [Gavin 的 Claude] <at id="0">Alice</at> if (a &lt; b &amp;&amp; c) {}<br>next')
  expect(b.mentions).toEqual([{ id: 0, mentionText: "Alice", mentioned: { user: { id: "u-a", displayName: "Alice", userIdentityType: "aadUser" } } }])
})

test("a reply goes to the thread with the person's token and gives back its id", async () => {
  const { calls, graph } = fake(() => ({ status: 201, text: JSON.stringify({ id: "m2" }) }))
  expect(await graph.postReply("r1", bodyOf("tag", alice, "hi"))).toEqual({ ok: true, value: "m2" })
  expect(calls[0]?.url).toBe(`${BASE}/r1/replies`)
  expect(calls[0]?.init?.method).toBe("POST")
  expect(calls[0]?.init?.headers?.Authorization).toBe("Bearer tok")
})

test("a lapsed token and throttling come back as such", async () => {
  expect(await fake(() => ({ status: 401 })).graph.me()).toEqual({ ok: false, reason: "auth", status: 401 })
  expect(await fake(() => ({ status: 429, headers: { "retry-after": "7" } })).graph.replies("r1")).toEqual({ ok: false, reason: "rate", status: 429, retryAfterS: 7 })
})

test("replies read back as plain text with their author and time", async () => {
  const value = [{ id: "m2", replyToId: "r1", from: { user: { id: "u-a", displayName: "Alice" } }, body: { content: "<p>use <code>a&lt;b</code></p><p>ok</p>" }, createdDateTime: "2026-11-25T01:00:00Z" }]
  const { graph } = fake(() => ({ text: JSON.stringify({ value }) }))
  expect(await graph.replies("r1")).toEqual({ ok: true, value: [{ id: "m2", rootId: "r1", from: alice, text: "use a<b\nok", at: Date.parse("2026-11-25T01:00:00Z"), mentions: [] }] })
})

test("HTML reads back as text", async () => {
  expect(textOf('<p>use <code>a&lt;b</code></p><p>ok</p>')).toBe("use a<b\nok")
  expect(textOf('🤖 [A 的 Claude] <at id="0">Bob</at> line one<br>line &amp; two')).toBe("🤖 [A 的 Claude] Bob line one\nline & two")
})
