import { expect, test } from "claude-code/testing"

import { BASE, OPTIONS, start } from "./start.ts"

const opts = { options: OPTIONS }
const STRATEGY = { [`${BASE}/strategy.json`]: JSON.stringify({ text: "Answer about orders.", setAt: 1 }) }
const CHAT = "/home/agent-chat"
const fromAlice = (text: string) => `🤖 [Alice 的 Claude] <at id="0">Gavin</at> ${text}`
const thread = (rootId: string, owner: string, extra: object = {}) => ({
  [`${BASE}/threads/${rootId}.json`]: JSON.stringify({ rootId, owner, other: { id: "u-a", name: "Alice" }, count: 1, isClosed: false, seen: [rootId], ...extra }),
})
const signInPrompts = (submitted: string[]) => submitted.filter((s) => s.includes("[teams-agent-chat · sign-in]"))

test("a refresh that fails for want of network is no lapse: no sign-in prompt, and polling resumes", opts, async ($, on) => {
  const { call, teams, clock, submitted } = await start($, on, { files: STRATEGY })
  await call("ask", { person: "Alice", question: "q" })
  const rootId = [...teams.roots.keys()][0]!
  teams.loginDown()
  await clock.advance(2 * 3600_000)
  expect(signInPrompts(submitted)).toHaveLength(0)
  teams.loginDown(false)
  teams.colleague(rootId, fromAlice("back online answer"))
  await clock.advance(15_000)
  expect(submitted.join()).toContain("back online answer")
})

test("after a lapse, the session picks up again once its token works, and only one session asks", opts, async ($, on) => {
  const { call, teams, clock, submitted, files } = await start($, on, { files: STRATEGY })
  await call("ask", { person: "Alice", question: "q" })
  const rootId = [...teams.roots.keys()][0]!
  teams.refuseRefresh()
  await clock.advance(2 * 3600_000)
  expect(signInPrompts(submitted)).toHaveLength(1)
  expect(files.get(`${BASE}/signin-asked`)).toBeTruthy()
  teams.refuseRefresh(false)
  teams.colleague(rootId, fromAlice("after sign-in"))
  await clock.advance(15_000)
  expect(submitted.join()).toContain("after sign-in")
})

test("a session finding a recent sign-in request from another session does not ask again", opts, async ($, on) => {
  const { call, teams, clock, submitted, files } = await start($, on, { files: STRATEGY })
  await call("ask", { person: "Alice", question: "q" })
  files.set(`${BASE}/signin-asked`, String(clock.now() + 3600_000))
  teams.refuseRefresh()
  await clock.advance(2 * 3600_000)
  expect(signInPrompts(submitted)).toHaveLength(0)
})

test("a restarted chat session takes up its incoming threads quietly", opts, async ($, on) => {
  const { teams, clock, submitted, files } = await start($, on, { cwd: CHAT, files: { ...STRATEGY, ...thread("r5", "s-old-chat", { isIncoming: true }) } })
  teams.colleague("r5", fromAlice("a follow-up"))
  await clock.advance(31_000)
  expect(teams.posted).toHaveLength(0)
  expect(submitted.join()).toContain("a follow-up")
  expect(JSON.parse(files.get(`${BASE}/threads/r5.json`)!)).toMatchObject({ owner: "s-me" })
  expect(JSON.parse(files.get(`${BASE}/threads/r5.json`)!).isTakenOver).toBeUndefined()
})

test("an owner missing from one read of the roster is not taken over", opts, async ($, on) => {
  const { teams, clock } = await start($, on, { cwd: CHAT, files: { ...STRATEGY, ...thread("r9", "s-gone") } })
  teams.colleague("r9", fromAlice("answer"))
  await clock.advance(11_000)
  expect(teams.posted).toHaveLength(0)
})

test("reply refuses a thread another session owns", opts, async ($, on) => {
  const { call, teams } = await start($, on, { files: { ...STRATEGY, ...thread("r6", "s-other") } })
  expect(await call("reply", { threadId: "r6", text: "my answer" })).toContain("another session")
  expect(teams.posted).toHaveLength(0)
})

test("a thread quiet for a day is no longer polled", opts, async ($, on) => {
  const { teams, clock, files } = await start($, on, { files: STRATEGY })
  for (const [id, lastAt] of [["r7", clock.now() - 25 * 3600_000], ["r8", clock.now()]] as const) Object.entries(thread(id, "s-me", { lastAt })).forEach(([p, t]) => files.set(p, t))
  await clock.advance(21_000)
  expect(teams.calls.some((c) => c.includes("/r7/replies"))).toBe(false)
  expect(teams.calls.some((c) => c.includes("/r8/replies"))).toBe(true)
})

test("a colleague's posts count toward the thread's 200", opts, async ($, on) => {
  const { call, teams, clock, files } = await start($, on, { files: STRATEGY })
  await call("ask", { person: "Alice", question: "q" })
  const rootId = [...teams.roots.keys()][0]!
  teams.colleague(rootId, fromAlice("one"))
  teams.colleague(rootId, fromAlice("two"))
  await clock.advance(11_000)
  expect(JSON.parse(files.get(`${BASE}/threads/${rootId}.json`)!).count).toBe(3)
})

test("read_thread shows the question and every post, hand-written ones marked", opts, async ($, on) => {
  const { call, teams } = await start($, on, { files: STRATEGY })
  await call("ask", { person: "Alice", question: "page or cursor?" })
  const rootId = [...teams.roots.keys()][0]!
  teams.colleague(rootId, "typed by hand")
  teams.colleague(rootId, fromAlice("cursor"))
  const r = await call("read_thread", { threadId: rootId })
  expect(r).toContain("page or cursor?")
  expect(r).toContain("cursor")
  expect(r).toContain("Alice (typed by hand): typed by hand")
})

test("not signed in, the Keychain is read at most once per poll, not every second", opts, async ($, on) => {
  const { clock, keychain } = await start($, on, { files: STRATEGY, signedIn: false })
  await clock.advance(30_000)
  expect(keychain.reads).toBeLessThanOrEqual(4)
})
