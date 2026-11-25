import { expect, test } from "claude-code/testing"

import { asksFor, rosterOf } from "../hooks/roster.ts"

test("the roster is every running session with a name, from Claude Code's own records", async () => {
  const row = { pid: 1, sessionId: "s1", cwd: "/work/orders-api", kind: "interactive", name: "orders-api", status: "busy", updatedAt: 5 }
  expect(rosterOf([row, {}, { sessionId: "s2", cwd: "/x" }, "junk"])).toEqual([
    { sessionId: "s1", name: "orders-api", cwd: "/work/orders-api", status: "busy", kind: "interactive" },
  ])
})

test("a session takes up only fresh side questions addressed to it, oldest first", async () => {
  const asks = [
    { id: "b", to: "s1", question: "q2", at: 200_000 },
    { id: "a", to: "s1", question: "q1", at: 150_000 },
    { id: "c", to: "s2", question: "q3", at: 200_000 },
    { id: "d", to: "s1", question: "old", at: 1_000 },
  ]
  expect(asksFor("s1", asks, 210_000).map((x) => x.id)).toEqual(["a", "b"])
})
