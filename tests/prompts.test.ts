import { expect, test } from "claude-code/testing"

import { DEFAULT_STRATEGY, incomingPrompt, replyPrompt, setupPrompt } from "../hooks/prompts.ts"
import type { Thread } from "../hooks/threads.ts"

const alice = { id: "u-a", name: "Alice" }
const thread: Thread = { rootId: "r1", owner: "chat", other: alice, count: 1, isClosed: false, seen: [] }
const posts = [
  { id: "r1", rootId: "r1", from: alice, text: "🤖 [Alice 的 Claude] Gavin page or cursor?", at: 1 },
  { id: "m2", rootId: "r1", from: alice, text: "🤖 [Alice 的 Claude] Gavin and the limit?", at: 2 },
]
const roster = [
  { sessionId: "s1", name: "orders-api", cwd: "/work/orders-api", status: "busy", kind: "interactive" },
  { sessionId: "s2", name: "billing", cwd: "/work/billing", status: "idle", kind: "interactive" },
]

test("an incoming question carries the strategy, the roster and how to hand it over", async () => {
  const p = incomingPrompt(thread, posts, "Only answer about orders.", roster)
  for (const part of ["Only answer about orders.", "orders-api", "/work/orders-api", "billing", "/work/billing", "[thread r1]", "SendMessage", "a colleague", "page or cursor?"]) expect(p).toContain(part)
  expect(p).not.toContain("your person said")
})

test("the setup conversation covers sign-in, the six questions and the chat session's folder", async () => {
  const p = setupPrompt()
  for (const part of ["sign_in", "answer directly", "repositories", "never be shared", "new threads", "end a thread", "review", "~/agent-chat", "permission mode", "strategy"]) expect(p).toContain(part)
})

test("a reply wakes the session that asked with every new post, in order", async () => {
  const p = replyPrompt(thread, posts, DEFAULT_STRATEGY)
  expect(p.indexOf("page or cursor?")).toBeLessThan(p.indexOf("and the limit?"))
  expect(p).toContain("[thread r1]")
  expect(p).toContain(DEFAULT_STRATEGY)
})
