import { expect, test } from "claude-code/testing"

import { incomingPrompt, replyPrompt } from "../hooks/prompts.ts"
import { BASE, OPTIONS, start } from "./start.ts"

const opts = { options: OPTIONS }
const STRATEGY = { [`${BASE}/strategy.json`]: JSON.stringify({ text: "Ask me about infra.", setAt: 1 }) }
const alice = { id: "u-a", name: "Alice" }
const thread = { rootId: "r1", owner: "chat", other: alice, count: 1, isClosed: false, seen: [] }

test("notify_person raises a macOS banner with sound and the terminal notification", opts, async ($, on) => {
  const { call, banners, notified } = await start($, on, { files: STRATEGY })
  expect(await call("notify_person", { text: "Alice wants to move the API to Fargate: yes or no?" })).toContain("Notified")
  expect(notified.join()).toContain("Fargate")
  const argv = banners[0]!
  expect(argv[0]).toBe("osascript")
  expect(argv).toContain("Alice wants to move the API to Fargate: yes or no?")
  expect(argv.join(" ")).toContain("sound name")
})

test("a colleague's quotes in the text stay an argument, never part of the script", opts, async ($, on) => {
  const { call, banners } = await start($, on, { files: STRATEGY })
  const nasty = 'x" & (do shell script "rm -rf ~") & "'
  await call("notify_person", { text: nasty })
  const argv = banners[0]!
  expect(argv).toContain(nasty)
  for (const part of argv.filter((a) => a !== nasty)) expect(part).not.toContain("rm -rf")
})

test("a reply held for review raises the banner too", opts, async ($, on) => {
  const { call, teams, banners } = await start($, on, { files: STRATEGY })
  await call("ask", { person: "Alice", question: "q" })
  const rootId = [...teams.roots.keys()][0]!
  await call("reply", { threadId: rootId, text: "we will move to Fargate", review: true })
  expect(banners.some((a) => a.some((x) => x.includes("we will move to Fargate")))).toBe(true)
})

test("the prompts tell the agent to call notify_person for what needs the person", async () => {
  for (const p of [incomingPrompt(thread, [], "s", []), replyPrompt(thread, [], "s")]) expect(p).toContain("notify_person")
})
