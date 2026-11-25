import { expect, test } from "claude-code/testing"

import { BASE, OPTIONS, T, start } from "./start.ts"

const opts = { options: OPTIONS }
const STRATEGY = { [`${BASE}/strategy.json`]: JSON.stringify({ text: "Answer about orders.", setAt: 1 }) }
const CHAT = "/home/agent-chat"
const fromAlice = (text: string) => `🤖 [Alice 的 Claude] <at id="0">Gavin</at> ${text}`
const thread = (rootId: string, owner: string, extra: object = {}) => ({
  [`${BASE}/threads/${rootId}.json`]: JSON.stringify({ rootId, owner, other: { id: "u-a", name: "Alice" }, count: 1, isClosed: false, seen: [rootId], ...extra }),
})

test("a colleague's reply wakes the session that asked within ten seconds, typed by hand too; my own posts do not", opts, async ($, on) => {
  const { call, teams, clock, submitted } = await start($, on, { files: STRATEGY })
  await call("ask", { person: "Alice", question: "page or cursor?" })
  const rootId = [...teams.roots.keys()][0]!
  teams.colleague(rootId, "🤖 [Gavin's Claude] <at>Alice</at> my own", { id: "u-me", displayName: "Gavin" })
  teams.colleague(rootId, "typed by me in Teams", { id: "u-me", displayName: "Gavin" }, [])
  await clock.advance(11_000)
  expect(submitted).toHaveLength(0)
  teams.colleague(rootId, "Alice typing by hand, no @", undefined, [])
  await clock.advance(11_000)
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toContain("Alice typing by hand, no @")
  submitted.length = 0
  teams.colleague(rootId, fromAlice("use cursor"))
  await clock.advance(11_000)
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toContain("use cursor")
  expect(submitted[0]).toContain(`[thread ${rootId}]`)
  await clock.advance(30_000)
  expect(submitted).toHaveLength(1)
})

test("replies that arrive while the person is typing come as one wake once the prompt is empty", opts, async ($, on) => {
  const { call, teams, clock, submitted, prompt } = await start($, on, { files: STRATEGY })
  await call("ask", { person: "Alice", question: "q" })
  const rootId = [...teams.roots.keys()][0]!
  prompt.text = "half a thought"
  for (const t of ["one", "two", "three"]) teams.colleague(rootId, fromAlice(t))
  await clock.advance(31_000)
  expect(submitted).toHaveLength(0)
  prompt.text = ""
  await clock.advance(2_000)
  expect(submitted).toHaveLength(1)
  for (const t of ["one", "two", "three"]) expect(submitted[0]).toContain(t)
})

test("the chat session takes up a new thread that @mentions its person; another session does not", opts, async ($, on) => {
  const { teams, clock, submitted, files } = await start($, on, { cwd: CHAT, files: STRATEGY })
  const rootId = teams.colleagueRoot(fromAlice("page or cursor?"), ["u-me"])
  teams.colleagueRoot(fromAlice("not for you"), ["u-bob"])
  await clock.advance(31_000)
  expect(JSON.parse(files.get(`${BASE}/threads/${rootId}.json`) ?? "{}")).toMatchObject({ owner: "s-me", isIncoming: true })
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toContain("[teams-agent-chat · question]")
  expect(submitted[0]).toContain("page or cursor?")
  expect(submitted[0]).not.toContain("not for you")
})

test("the chat session takes up a colleague's hand-written post that @mentions its person", opts, async ($, on) => {
  const { teams, clock, submitted } = await start($, on, { cwd: CHAT, files: STRATEGY })
  teams.colleagueRoot('<at id="0">Gavin</at> where does the Frank voice config live?', ["u-me"])
  await clock.advance(31_000)
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toContain("where does the Frank voice config live?")
  expect(submitted[0]).toContain("typed by hand")
})

test("a session outside ~/agent-chat never takes up new threads", opts, async ($, on) => {
  const { teams, clock, submitted } = await start($, on, { files: STRATEGY })
  teams.colleagueRoot(fromAlice("page or cursor?"), ["u-me"])
  await clock.advance(31_000)
  expect(submitted).toHaveLength(0)
})

test("a thread whose session has closed is taken over: the person is told, the thread is told once, and it wakes no more", opts, async ($, on) => {
  const { teams, clock, submitted, notified } = await start($, on, { cwd: CHAT, files: { ...STRATEGY, ...thread("r9", "s-gone") } })
  teams.colleague("r9", fromAlice("here is the answer"))
  // Missing from three polls in a row before it counts as closed.
  await clock.advance(31_000)
  expect(notified.join()).toContain("here is the answer")
  expect(teams.posted).toHaveLength(1)
  expect(teams.posted[0]?.body.body.content).toContain("has closed")
  teams.colleague("r9", fromAlice("and more"))
  await clock.advance(30_000)
  expect(teams.posted).toHaveLength(1)
  expect(submitted).toHaveLength(0)
})

test("ten minutes after a handover with no answer, the thread hears once that it is being worked on", opts, async ($, on) => {
  const { teams, clock } = await start($, on, { cwd: CHAT, files: { ...STRATEGY, ...thread("r1", "s-me", { isIncoming: true }) } })
  await $.tool.call({ tool: "SendMessage", to: "orders-api", message: "[thread r1] A colleague (Alice) asks: page or cursor?" } as never)
  await clock.advance(9 * 60_000)
  expect(teams.posted).toHaveLength(0)
  await clock.advance(2 * 60_000)
  expect(teams.posted).toHaveLength(1)
  expect(teams.posted[0]?.body.body.content).toContain("Still working on it")
  await clock.advance(20 * 60_000)
  expect(teams.posted).toHaveLength(1)
})

test("throttled by Teams, polling waits out Retry-After", opts, async ($, on) => {
  const { call, teams, clock, submitted } = await start($, on, { files: STRATEGY })
  await call("ask", { person: "Alice", question: "q" })
  const rootId = [...teams.roots.keys()][0]!
  teams.failWith(429)
  await clock.advance(11_000)
  teams.failWith(200)
  teams.colleague(rootId, fromAlice("answer"))
  await clock.advance(15_000)
  expect(submitted).toHaveLength(0)
  await clock.advance(30_000)
  expect(submitted).toHaveLength(1)
})

test("with no strategy the setup conversation starts once; already asked or declined, it does not", opts, async ($, on) => {
  const { clock, submitted, files } = await start($, on)
  await clock.advance(5_000)
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toContain("[teams-agent-chat · setup]")
  expect(files.get(`${BASE}/setup-asked`)).toBeDefined()
  await clock.advance(60_000)
  expect(submitted).toHaveLength(1)
})

test("a session started after setup was asked elsewhere does not ask again", opts, async ($, on) => {
  const { clock, submitted } = await start($, on, { files: { [`${BASE}/setup-asked`]: "1" } })
  await clock.advance(5_000)
  expect(submitted).toHaveLength(0)
})

test("a lapsed sign-in pauses chat and asks once to sign in again", opts, async ($, on) => {
  const { call, teams, clock, submitted } = await start($, on, { files: STRATEGY })
  await call("ask", { person: "Alice", question: "q" })
  teams.refuseRefresh()
  await clock.advance(2 * 3600_000)
  expect(submitted.filter((s) => s.includes("[teams-agent-chat · sign-in]"))).toHaveLength(1)
})

test("a side question addressed to this session is answered from a fork of its context", opts, async ($, on) => {
  const { files, clock } = await start($, on, { files: { ...STRATEGY, [`${BASE}/peek/asks/q1.json`]: JSON.stringify({ id: "q1", to: "s-me", question: "what are you on?", at: Date.now() }) } })
  await clock.advance(2_000)
  expect(JSON.parse(files.get(`${BASE}/peek/replies/q1.json`) ?? "{}")).toEqual({ id: "q1", text: "working on the orders API, api/orders.ts" })
})
