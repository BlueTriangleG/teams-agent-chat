import { expect, test } from "claude-code/testing"

import { BASE, OPTIONS, start } from "./start.ts"

const opts = { options: OPTIONS }

test("ask starts a thread tagged and @mentioning the colleague, owned by this session", opts, async ($, on) => {
  const { call, teams, files } = await start($, on)
  const r = await call("ask", { person: "Alice", question: "page or cursor?" })
  expect(r).toContain("r")
  const sent = teams.posted[0]!
  expect(sent.url).toBe("https://graph.microsoft.com/v1.0/teams/T1/channels/19%3Ac%40thread.tacv2/messages")
  expect(sent.body.body.content).toBe('🤖 [Gavin 的 Claude] <at id="0">Alice</at> page or cursor?')
  const rootId = [...teams.roots.keys()][0]!
  expect(JSON.parse(files.get(`${BASE}/threads/${rootId}.json`) ?? "{}")).toMatchObject({ rootId, owner: "s-me", other: { id: "u-a", name: "Alice" }, count: 1, isClosed: false })
})

test("a post with a key in it, past 200 or past ten a minute is refused", opts, async ($, on) => {
  const { call, teams, files } = await start($, on)
  await call("ask", { person: "Alice", question: "q" })
  const rootId = [...teams.roots.keys()][0]!
  expect(await call("reply", { threadId: rootId, text: "use AKIAIOSFODNN7EXAMPLE" })).toContain("AWS access key")
  expect(teams.posted).toHaveLength(1)
  const path = `${BASE}/threads/${rootId}.json`
  files.set(path, JSON.stringify({ ...JSON.parse(files.get(path)!), count: 200 }))
  expect(await call("reply", { threadId: rootId, text: "one more" })).toContain("200")
  files.set(path, JSON.stringify({ ...JSON.parse(files.get(path)!), count: 1 }))
  for (let i = 0; i < 9; i++) await call("reply", { threadId: rootId, text: `r${i}` })
  expect(await call("reply", { threadId: rootId, text: "eleventh" })).toContain("minute")
  expect(teams.posted).toHaveLength(10)
})

test("a reply held for review posts nothing until the person has typed in this session", opts, async ($, on) => {
  const { call, teams, notified, typed } = await start($, on)
  await call("ask", { person: "Alice", question: "q" })
  const rootId = [...teams.roots.keys()][0]!
  const held = await call("reply", { threadId: rootId, text: "the price is 40", review: true })
  expect(teams.posted).toHaveLength(1)
  expect(notified.join()).toContain("the price is 40")
  const draftId = held.match(/draft (\w+)/)?.[1] ?? ""
  expect(draftId).not.toBe("")
  expect(await call("approve", { draftId })).toContain("person")
  expect(teams.posted).toHaveLength(1)
  await typed("yes send it")
  expect(await call("approve", { draftId })).toContain("Posted")
  expect(teams.posted[1]?.body.body.content).toContain("the price is 40")
  expect(await call("approve", { draftId })).toContain("already")
})

test("the strategy is saved and read back; with none, the default applies", opts, async ($, on) => {
  const { call } = await start($, on)
  expect(await call("strategy", { action: "get" })).toContain("Answer questions about code")
  await call("strategy", { action: "set", text: "Only orders questions." })
  expect(await call("strategy", { action: "get" })).toContain("Only orders questions.")
})

test("peek asks another session what it is working on and returns its answer", opts, async ($, on) => {
  const sessions = { "/home/.claude/sessions/9.json": JSON.stringify({ sessionId: "s-orders", name: "orders-api", cwd: "/work/orders", status: "busy", kind: "interactive" }) }
  const { call, files, clock } = await start($, on, { files: sessions })
  const pending = call("peek", { session: "orders-api" })
  await clock.advance(1000)
  const ask = [...files.entries()].find(([p]) => p.startsWith(`${BASE}/peek/asks/`))
  expect(ask).toBeDefined()
  const id = JSON.parse(ask![1]).id
  files.set(`${BASE}/peek/replies/${id}.json`, JSON.stringify({ id, text: "orders API, api/orders.ts" }))
  await clock.advance(2000)
  expect(await pending).toContain("orders API, api/orders.ts")
})
