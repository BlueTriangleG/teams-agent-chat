import { expect, test } from "claude-code/testing"

import { announceBodyOf, bodyOf } from "../hooks/graph.ts"
import { newFor } from "../hooks/threads.ts"
import type { Thread } from "../hooks/threads.ts"
import { BASE, OPTIONS, start } from "./start.ts"

const opts = { options: OPTIONS }
const STRATEGY = { [`${BASE}/strategy.json`]: JSON.stringify({ text: "Answer about orders.", setAt: 1 }) }
const alice = { id: "u-a", name: "Alice" }
const bob = { id: "u-b", name: "Bob" }
const me = { id: "u-me", name: "Gavin" }

test("a post can @mention several people", async () => {
  const b = bodyOf("🤖 [Gavin 的 Claude]", [alice, bob], "page or cursor?")
  expect(b.body.content).toBe('🤖 [Gavin 的 Claude] <at id="0">Alice</at> <at id="1">Bob</at> page or cursor?')
  expect(b.mentions.map((m) => (m as { mentioned: { user: { id: string } } }).mentioned.user.id)).toEqual(["u-a", "u-b"])
})

test("an announcement @mentions the channel itself", async () => {
  const b = announceBodyOf("🤖 [Gavin 的 Claude]", { id: "19:c@thread.tacv2", name: "agent-chat" }, "hello all")
  expect(b.body.content).toBe('🤖 [Gavin 的 Claude] <at id="0">agent-chat</at> hello all')
  expect(b.mentions).toEqual([{ id: 0, mentionText: "agent-chat", mentioned: { conversation: { id: "19:c@thread.tacv2", displayName: "agent-chat", conversationIdentityType: "channel" } } }])
})

test("a tagged post that does not @mention me does not wake me", async () => {
  const t: Thread = { rootId: "r", owner: "s", other: alice, count: 1, isClosed: false, seen: [] }
  const posts = [
    { id: "p1", rootId: "r", from: bob, text: "🤖 [Bob 的 Claude] Alice mine is cursor", at: 1, mentions: ["u-a"] },
    { id: "p2", rootId: "r", from: alice, text: "🤖 [Alice 的 Claude] Gavin thanks both", at: 2, mentions: ["u-me", "u-b"] },
  ]
  expect(newFor(t, posts, me).map((p) => p.id)).toEqual(["p2"])
})

test("ask can put one question to several colleagues in one thread", opts, async ($, on) => {
  const { call, teams, files } = await start($, on, { files: STRATEGY })
  expect(await call("ask", { people: ["Alice", "Bob"], question: "page or cursor?" })).toContain("Posted")
  expect(teams.posted[0]?.body.body.content).toBe(`🤖 [Gavin's Claude] <at id="0">Alice</at> <at id="1">Bob</at> page or cursor?`)
  const rootId = [...teams.roots.keys()][0]!
  expect(JSON.parse(files.get(`${BASE}/threads/${rootId}.json`)!).people).toEqual([alice, bob])
})

test("both colleagues' answers wake me, and my follow-up @mentions both", opts, async ($, on) => {
  const { call, teams, clock, submitted } = await start($, on, { files: STRATEGY })
  await call("ask", { people: ["Alice", "Bob"], question: "q" })
  const rootId = [...teams.roots.keys()][0]!
  teams.colleague(rootId, `🤖 [Alice 的 Claude] <at id="0">Gavin</at> from Alice`)
  teams.colleague(rootId, `🤖 [Bob 的 Claude] <at id="0">Gavin</at> from Bob`, { id: "u-b", displayName: "Bob" })
  await clock.advance(11_000)
  expect(submitted.join()).toContain("from Alice")
  expect(submitted.join()).toContain("from Bob")
  await call("reply", { threadId: rootId, text: "thanks" })
  expect(teams.posted[1]?.body.mentions).toHaveLength(2)
})

test("an announcement goes to the whole channel and starts no thread", opts, async ($, on) => {
  const { call, teams, files } = await start($, on, { files: STRATEGY })
  expect(await call("announce", { text: "Hi all, I'm Gavin's Claude" })).toContain("channel")
  expect(teams.posted[0]?.body.body.content).toBe(`🤖 [Gavin's Claude] <at id="0">agent-chat</at> Hi all, I'm Gavin's Claude`)
  expect([...files.keys()].some((p) => p.startsWith(`${BASE}/threads/`))).toBe(false)
})

test("an announcement with a key in it is refused", opts, async ($, on) => {
  const { call, teams } = await start($, on, { files: STRATEGY })
  expect(await call("announce", { text: "use AKIAIOSFODNN7EXAMPLE" })).toContain("AWS access key")
  expect(teams.posted).toHaveLength(0)
})
