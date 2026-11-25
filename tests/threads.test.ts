import { expect, test } from "claude-code/testing"

import { canPost, createRate, isAgentPost, isEnd, newFor, tagOf } from "../hooks/threads.ts"
import type { Thread } from "../hooks/threads.ts"

const me = { id: "u-me", name: "Gavin" }
const alice = { id: "u-a", name: "Alice" }

test("an agent post carries its person's tag; a hand-written one does not", async () => {
  expect(tagOf("Alice")).toBe("🤖 [Alice's Claude]")
  expect(isAgentPost("🤖 [Alice's Claude] Gavin cursor")).toBe(true)
  // The first release tagged posts in Chinese; they still count.
  expect(isAgentPost("🤖 [Alice 的 Claude] Alice cursor")).toBe(true)
  expect(isEnd("🤖 [Alice's Claude] Gavin ✅ done", "Gavin")).toBe(true)
  expect(isAgentPost("typed by Alice herself 🤖 [Alice 的 Claude]")).toBe(false)
})

test("posts from the other side are new once, typed by hand or by their Claude; my own are not", async () => {
  const t: Thread = { rootId: "r", owner: "s1", other: alice, count: 1, isClosed: false, seen: ["r"] }
  const posts = [
    { id: "p1", rootId: "r", from: alice, text: "🤖 [Alice 的 Claude] Alice cursor", at: 2 },
    { id: "p2", rootId: "r", from: alice, text: "typed by Alice herself", at: 3 },
    { id: "p3", rootId: "r", from: me, text: "🤖 [Gavin 的 Claude] thanks", at: 4 },
  ]
  expect(newFor(t, posts, me).map((p) => p.id)).toEqual(["p1", "p2"])
  expect(newFor({ ...t, seen: ["r", "p1", "p2"] }, posts, me)).toEqual([])
})

test("a thread takes 200 agent posts and nothing after ✅", async () => {
  const t: Thread = { rootId: "r", owner: "s", other: alice, count: 199, isClosed: false, seen: [] }
  expect(canPost(t)).toEqual({ ok: true })
  expect(canPost({ ...t, count: 200 })).toEqual({ ok: false, reason: "limit" })
  expect(canPost({ ...t, isClosed: true })).toEqual({ ok: false, reason: "closed" })
  expect(isEnd("🤖 [A 的 Claude] ✅ done")).toBe(true)
  // A post as read back carries the @mention between the tag and the text.
  expect(isEnd("🤖 [A 的 Claude] Alice Wang ✅ done", "Alice Wang")).toBe(true)
  expect(isEnd("🤖 [A 的 Claude] Bob ✅ done", "Alice Wang")).toBe(false)
  expect(isEnd("🤖 [A 的 Claude] not ✅ yet")).toBe(false)
})

test("ten posts a minute, then the eleventh waits for the window", async () => {
  const rate = createRate()
  for (let i = 0; i < 10; i++) expect(rate.allow(1000 + i)).toBe(true)
  expect(rate.allow(1010)).toBe(false)
  expect(rate.allow(61_001)).toBe(true)
})
