import type { EngineInterface, Register } from "claude-code"

import { createTokens, pollSignIn, startSignIn } from "./auth.ts"
import type { SignIn, TokenCache } from "./auth.ts"
import { announceBodyOf, bodyOf, createGraph } from "./graph.ts"
import { secretsIn } from "./guard.ts"
import { parseChannelLink } from "./link.ts"
import type { Place } from "./link.ts"
import { DEFAULT_STRATEGY, incomingPrompt, lineOf, replyPrompt, setupPrompt, signInAgainPrompt, stillWorkingText, takenOverText } from "./prompts.ts"
import { PEEK_QUESTION, asksFor, rosterOf } from "./roster.ts"
import type { PeekAsk } from "./roster.ts"
import { createState } from "./state.ts"
import type { Disk, Draft } from "./state.ts"
import { canPost, createRate, isEnd, newFor, recipientsOf, tagOf } from "./threads.ts"
import type { Person, Post, Thread } from "./threads.ts"

const PLUGIN = "teams-agent-chat"
const PREFIX = `mcp__${PLUGIN}__`
const PEEK_TRIES = 60
const TICK_MS = 1000
const POLL_MS = 10_000
const SCAN_MS = 30_000
const STILL_MS = 10 * 60_000
const QUIET_MS = 24 * 3600_000
// A sign-in request from any session covers the others for this long.
const SIGN_IN_ASKED_MS = 6 * 3600_000
// Polls in a row a thread's owner must be missing before it is taken over: one bad
// read of a session file is not a closed session.
const MISSING_POLLS = 3

const app = {
  base: "",
  sessionsDir: "",
  sessionId: "",
  cwd: "",
  home: "",
  isChat: false,
  isInteractive: false,
  place: undefined as Place | undefined,
  clientId: "",
  tokenCache: {} as TokenCache,
  me: undefined as Person | undefined,
  rate: createRate(),
  // Bumped by each prompt the person types here (or sends from their phone): a held
  // draft may go out only after one.
  humanSeq: 0,
  // The engine's clock ($.clock.now), read at each hook's start: app.now is not the
  // session's time (nor a test's).
  now: 0,
  signIn: undefined as SignIn | undefined,
  // A lapsed sign-in was brought to the person; polling waits for sign_in.
  isSignInAsked: false,
  stop: undefined as (() => void) | undefined,
}

// The tick's own state: when it last polled, what waits to be handed to the session.
const tick = {
  isBusy: false,
  lastPoll: 0,
  lastScan: 0,
  pausedUntil: 0,
  isWaking: false,
  isSetupChecked: false,
  answering: new Set<string>(),
  missing: new Map<string, number>(),
  notes: [] as string[],
  pending: new Map<string, { thread: Thread; posts: Post[] }>(),
}

type $ = EngineInterface

function diskOf($: $): Disk {
  return {
    read: (p) => $.fs.read(p).then((t) => String(t)).catch(() => undefined),
    write: (p, t) => $.fs.write(p, t),
    list: (d) => $.fs.list(d).then((es) => es.map((e) => e.name)).catch(() => []),
  }
}

const fetchOf = ($: $) => (url: string, init?: Parameters<EngineInterface["http"]["fetch"]>[1]) => $.http.fetch(url, init)
const runOf = ($: $) => (argv: string[]) => $.process.run(argv).then((r) => ({ exitCode: r.exitCode ?? 1, stdout: r.stdout ?? "" }))
const isSetUp = () => app.place !== undefined && app.clientId !== ""
const stateOf = ($: $) => createState(diskOf($), app.base)
function tokensOf($: $) {
  const place = app.place!
  return createTokens(fetchOf($), runOf($), place.tenantId, app.clientId, `${place.tenantId}/${app.clientId}`, () => app.now, app.tokenCache)
}
function graphOf($: $) {
  const tokens = tokensOf($)
  return createGraph(fetchOf($), () => tokens.get(), app.place!)
}

function idOf(now: number): string {
  return `${now.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`
}

const NOT_SET_UP = `${PLUGIN} is not set up: fill in its Application (client) ID and Channel link in /config.`
const NOT_SIGNED_IN = `Not signed in to Teams: call ${PREFIX}sign_in.`

async function meOf($: $): Promise<Person | undefined> {
  if (app.me !== undefined) return app.me
  if (!isSetUp()) return undefined
  const got = await graphOf($).me()
  if (got.ok) app.me = got.value
  else paused(got, app.now)
  return app.me
}

function failed(got: { reason: string; status: number }): string {
  if (got.reason === "auth") return NOT_SIGNED_IN
  if (got.reason === "rate") return "Teams is throttling; nothing was posted. Try again in a minute."
  return `Teams refused it (HTTP ${got.status}); nothing was posted.`
}

// Every post goes through here: the guard, the thread's limits, the rate, then Teams.
function secretRefusal(text: string): string | undefined {
  const secrets = secretsIn(text)
  return secrets.length > 0 ? `Refused: the text looks like it holds a ${secrets.join(", ")}. Nothing was posted.` : undefined
}
const RATE_REFUSAL = "Refused: at most 10 posts a minute. Try again shortly."

async function post($: $, thread: Thread | undefined, to: Person[], text: string): Promise<string> {
  const refused = secretRefusal(text)
  if (refused !== undefined) return refused
  if (thread !== undefined) {
    const can = canPost(thread)
    if (!can.ok) return can.reason === "limit" ? "Refused: this thread has reached its 200 agent posts." : "Refused: this thread has ended (✅)."
  }
  if (!app.rate.allow(app.now)) return RATE_REFUSAL
  const me = await meOf($)
  if (me === undefined) return NOT_SIGNED_IN
  const graph = graphOf($)
  const body = bodyOf(tagOf(me.name), to, text)
  const got = thread === undefined ? await graph.postRoot(body) : await graph.postReply(thread.rootId, body)
  if (!got.ok) return failed(got)
  // Onto the copy on disk now: the tick may have marked replies seen while Teams answered.
  const latest = thread === undefined ? undefined : ((await stateOf($).loadThread(thread.rootId)) ?? thread)
  const saved: Thread =
    latest === undefined
      ? { rootId: got.value, owner: app.sessionId, other: to[0]!, ...(to.length > 1 ? { people: to } : {}), count: 1, isClosed: isEnd(text), seen: [got.value], lastAt: app.now }
      : { ...latest, count: latest.count + 1, isClosed: latest.isClosed || isEnd(text), seen: [...latest.seen, got.value], handoverAt: undefined, lastAt: app.now }
  await stateOf($).saveThread(saved)
  return `Posted in [thread ${saved.rootId}].`
}

// Gets the person's attention: Claude Code's own notification (which a terminal such as
// herdr may swallow without saying so) and a macOS banner with a sound, which does not
// depend on the terminal. The text goes to osascript as an argument, never into the script.
async function alert($: $, text: string) {
  await $.ui.notify(text, { title: "Teams agent chat" }).catch(() => undefined)
  await $.process
    .run([
      "osascript",
      "-e",
      "on run argv",
      "-e",
      'display notification (item 1 of argv) with title (item 2 of argv) sound name "Glass"',
      "-e",
      "end run",
      "--",
      text.slice(0, 400),
      "Teams agent chat",
    ])
    .catch(() => undefined)
}

// One post @mentioning the whole channel: everyone is notified, no thread is kept, and no
// one's Claude wakes (they wake only for posts that @mention their person).
async function announce($: $, text: string): Promise<string> {
  const refused = secretRefusal(text)
  if (refused !== undefined) return refused
  if (!app.rate.allow(app.now)) return RATE_REFUSAL
  const me = await meOf($)
  if (me === undefined) return NOT_SIGNED_IN
  const graph = graphOf($)
  const name = await graph.channelName()
  const channel = { id: app.place!.channelId, name: name.ok && name.value ? name.value : "channel" }
  const got = await graph.postRoot(announceBodyOf(tagOf(me.name), channel, text))
  return got.ok ? `Announced to the whole channel (@${channel.name}).` : failed(got)
}

async function hold($: $, d: Omit<Draft, "id" | "at" | "session">, what: string): Promise<string> {
  const draft: Draft = { ...d, id: idOf(app.now), at: app.humanSeq, session: app.sessionId }
  await stateOf($).saveDraft(draft)
  await alert($, `Review needed — ${what}: ${d.text}`)
  return `Held as draft ${draft.id} for your person's review. Show them the text; once they say yes here, call ${PREFIX}approve with draftId ${draft.id}.`
}

async function peers($: $) {
  const disk = diskOf($)
  const names = await disk.list(app.sessionsDir)
  const rows = await Promise.all(
    names
      .filter((n) => n.endsWith(".json"))
      .map(async (n) => {
        try {
          return JSON.parse((await disk.read(`${app.sessionsDir}/${n}`)) ?? "") as unknown
        } catch {
          return undefined
        }
      }),
  )
  return rosterOf(rows).filter((p) => p.sessionId !== app.sessionId)
}

type Input = Record<string, unknown>
const str = (v: unknown) => (typeof v === "string" ? v : "")

async function serve($: $, tool: string, input: Input): Promise<string> {
  if (tool === "strategy") return strategyTool($, input)
  if (!isSetUp()) return NOT_SET_UP
  const state = stateOf($)
  const graph = graphOf($)
  switch (tool) {
    case "sign_in":
      return signInTool($)
    case "ask": {
      const names = Array.isArray(input.people) ? input.people.map(str).filter(Boolean) : [str(input.person)].filter(Boolean)
      if (names.length === 0) return "Say whom to ask: people, a list of names or emails."
      const to: Person[] = []
      for (const name of names) {
        const found = await graph.findUser(name)
        if (!found.ok) return failed(found)
        if (found.value.length === 0) return `No one in Teams matches "${name}". Nothing was posted.`
        if (found.value.length > 1) return `Several people match "${name}": ${found.value.map((p) => p.name).join(", ")}. Say which. Nothing was posted.`
        if (!to.some((p) => p.id === found.value[0]!.id)) to.push(found.value[0]!)
      }
      const text = str(input.question)
      if (input.review === true) return hold($, { to, text }, `question to ${to.map((p) => p.name).join(", ")}`)
      return post($, undefined, to, text)
    }
    case "announce": {
      const text = str(input.text)
      if (input.review === true) {
        const refused = secretRefusal(text)
        return refused ?? hold($, { text, isAnnounce: true }, "announcement to the channel")
      }
      return announce($, text)
    }
    case "reply": {
      const thread = await state.loadThread(str(input.threadId))
      if (thread === undefined) return `No thread ${str(input.threadId)} here.`
      if (thread.owner !== app.sessionId)
        return "That thread belongs to another session; only it posts there. If you were handed this question, send your answer back to the session that handed it to you, by SendMessage."
      const text = str(input.text)
      const to = recipientsOf(thread)
      if (input.review === true && canPost(thread).ok) return hold($, { threadId: thread.rootId, text }, `reply to ${to.map((p) => p.name).join(", ")}`)
      return post($, thread, to, text)
    }
    case "approve": {
      const draft = await state.loadDraft(str(input.draftId))
      if (draft === undefined || draft.session !== app.sessionId) return `No draft ${str(input.draftId)} in this session.`
      if (draft.isSent) return "That draft was already posted."
      if (app.humanSeq <= draft.at) return "Not yet: your person has to say yes in this session first."
      const thread = draft.threadId === undefined ? undefined : await state.loadThread(draft.threadId)
      const to = thread === undefined ? draft.to : recipientsOf(thread)
      if (!draft.isAnnounce && (to === undefined || to.length === 0)) return "That draft has lost its thread."
      const r = draft.isAnnounce ? await announce($, draft.text) : await post($, thread, to!, draft.text)
      if (r.startsWith("Posted") || r.startsWith("Announced")) await state.saveDraft({ ...draft, isSent: true })
      return r
    }
    case "read_thread": {
      const id = str(input.threadId)
      const thread = await state.loadThread(id)
      const [root, got] = await Promise.all([graph.root(id), graph.replies(id)])
      if (!got.ok) return failed(got)
      const posts = [...(root.ok && root.value !== undefined ? [root.value] : []), ...got.value]
      const head = `[thread ${id}]${thread ? ` with ${thread.other.name}, ${thread.count} agent posts${thread.isClosed ? ", ended" : ""}` : ""}`
      return [head, ...posts.map(lineOf)].join("\n")
    }
    case "notify_person": {
      const text = str(input.text).trim()
      if (text === "") return "Say what your person needs to decide."
      await alert($, text)
      return "Notified your person (a Mac banner with a sound). Wait for their answer here before posting anything that depends on it."
    }
    case "peek":
      return peekTool($, str(input.session), str(input.question) || PEEK_QUESTION)
  }
  return `Unknown tool ${tool}.`
}

async function strategyTool($: $, input: Input): Promise<string> {
  const state = stateOf($)
  if (input.action === "set") {
    const isDeclined = input.isDeclined === true
    await state.saveStrategy({ text: str(input.text), ...(isDeclined ? { isDeclined: true as const } : {}), setAt: app.now })
    return isDeclined ? "Noted: no strategy for now; the default applies." : "Strategy saved."
  }
  const s = await state.loadStrategy()
  return s === undefined || s.isDeclined || s.text.trim() === "" ? `No strategy set; the default applies: ${DEFAULT_STRATEGY}` : s.text
}

async function signInTool($: $): Promise<string> {
  const place = app.place!
  const now = app.now
  if (app.signIn !== undefined && app.signIn.expiresAt > now) {
    const r = await pollSignIn(fetchOf($), place.tenantId, app.clientId, app.signIn.deviceCode, now)
    if (r.status === "pending") return `Not finished yet: open ${app.signIn.link} and enter ${app.signIn.userCode}, then call sign_in again.`
    app.signIn = undefined
    if (r.status === "failed") return `Sign-in failed (${r.reason}). Call sign_in to start over.`
    await tokensOf($).use(r)
    app.isSignInAsked = false
    app.me = undefined
    const me = await meOf($)
    return `Signed in to Teams${me ? ` as ${me.name}` : ""}.`
  }
  const r = await startSignIn(fetchOf($), place.tenantId, app.clientId, now)
  if ("failed" in r) return `Could not start sign-in: ${r.failed}`
  app.signIn = r
  return `Open ${r.link} and enter the code ${r.userCode}. Then call sign_in again.`
}

async function peekTool($: $, name: string, question: string): Promise<string> {
  const all = await peers($)
  const peer = all.find((p) => p.name === name) ?? all.find((p) => p.name.toLowerCase() === name.toLowerCase())
  if (peer === undefined) return `No running session is named "${name}".`
  const disk = diskOf($)
  const id = idOf(app.now)
  await disk.write(`${app.base}/peek/asks/${id}.json`, JSON.stringify({ id, to: peer.sessionId, question, at: app.now }))
  for (let i = 0; i < PEEK_TRIES; i++) {
    await $.clock.sleep(1000)
    const text = await disk.read(`${app.base}/peek/replies/${id}.json`)
    if (!text) continue
    try {
      return `${peer.name}: ${(JSON.parse(text) as { text?: string }).text ?? ""}`
    } catch {
      break
    }
  }
  return `No answer from ${peer.name} within a minute; it may not have this plugin.`
}

function queue(thread: Thread, posts: Post[]) {
  const had = tick.pending.get(thread.rootId)?.posts ?? []
  tick.pending.set(thread.rootId, { thread, posts: [...had, ...posts.filter((p) => !had.some((h) => h.id === p.id))] })
}

async function strategyText($: $): Promise<string> {
  const s = await stateOf($).loadStrategy()
  return s === undefined || s.isDeclined || s.text.trim() === "" ? DEFAULT_STRATEGY : s.text
}

// A rate answer pauses all polling; true when polling should stop for now.
function paused(got: { ok: boolean; reason?: string; retryAfterS?: number }, now: number): boolean {
  if (got.ok || got.reason !== "rate") return false
  tick.pausedUntil = now + (got.retryAfterS ?? 30) * 1000
  return true
}

// Tried once a poll interval. A refresh that fails for now (no network on waking, an
// outage) is tried again next time; one refused for good is brought to the person, by
// one session for all, and polling picks up by itself once a token works again.
async function signedInMe($: $): Promise<Person | undefined> {
  const marker = `${app.base}/signin-asked`
  if ((await tokensOf($).get()) !== undefined) {
    if (app.isSignInAsked) {
      app.isSignInAsked = false
      await diskOf($).write(marker, "")
    }
    return meOf($)
  }
  if (app.tokenCache.lapsed && !app.isSignInAsked) {
    app.isSignInAsked = true
    const askedAt = Number((await diskOf($).read(marker)) || 0)
    if (!askedAt || app.now - askedAt >= SIGN_IN_ASKED_MS) {
      await diskOf($).write(marker, String(app.now))
      tick.notes.push(signInAgainPrompt())
    }
  }
  return undefined
}

async function poll($: $, me: Person, now: number) {
  const state = stateOf($)
  const graph = graphOf($)
  const threads = (await state.listThreads()).filter((t) => !t.isClosed)
  const live = new Set([app.sessionId, ...(app.isChat ? (await peers($)).map((p) => p.sessionId) : [])])
  for (const found of threads) {
    let thread = found
    if (thread.lastAt !== undefined && now - thread.lastAt > QUIET_MS) continue
    if (thread.owner !== app.sessionId) {
      if (!app.isChat || live.has(thread.owner)) {
        tick.missing.delete(thread.rootId)
        continue
      }
      const missing = (tick.missing.get(thread.rootId) ?? 0) + 1
      tick.missing.set(thread.rootId, missing)
      if (missing < MISSING_POLLS) continue
      tick.missing.delete(thread.rootId)
      // A colleague's thread was the chat session's to begin with: a restarted chat session
      // carries on with it. One a working session started has lost the session that asked.
      thread = thread.isIncoming ? { ...thread, owner: app.sessionId } : { ...thread, owner: app.sessionId, isTakenOver: true }
      await state.saveThread(thread)
    }
    const got = await graph.replies(thread.rootId)
    if (paused(got, now)) return
    if (!got.ok) continue
    const fresh = newFor(thread, got.value, me)
    if (fresh.length === 0) continue
    if (thread.isTakenOver) {
      await alert($, `${thread.other.name} answered in a thread whose session has closed: ${fresh[fresh.length - 1]!.text}`)
      await post($, thread, recipientsOf(thread), takenOverText())
      const after = (await state.loadThread(thread.rootId)) ?? thread
      await state.saveThread({ ...after, seen: [...after.seen, ...fresh.map((p) => p.id)], isClosed: true })
      continue
    }
    queue(thread, fresh)
  }
}

// The chat session takes up new threads that @mention its person, from when it was set up.
async function scan($: $, me: Person, now: number) {
  const state = stateOf($)
  const got = await graphOf($).roots()
  if (paused(got, now) || !got.ok) return
  const since = Number((await diskOf($).read(`${app.base}/scan-since`)) ?? 0)
  for (const root of got.value) {
    // Typed by hand or by a colleague's Claude: any new post that @mentions this person.
    if (root.from.id === me.id || !root.mentions.includes(me.id) || root.at < since) continue
    if ((await state.loadThread(root.id)) !== undefined) continue
    const thread: Thread = { rootId: root.id, owner: app.sessionId, other: root.from, count: 1, isClosed: false, seen: [], isIncoming: true, lastAt: now }
    await state.saveThread(thread)
    queue(thread, [root])
  }
}

async function stillWorking($: $, now: number) {
  const state = stateOf($)
  for (const t of await state.listThreads()) {
    if (t.owner !== app.sessionId || t.isClosed || t.handoverAt === undefined || t.stillWorkingSent || now - t.handoverAt < STILL_MS) continue
    await post($, t, recipientsOf(t), stillWorkingText())
    const after = (await state.loadThread(t.rootId)) ?? t
    await state.saveThread({ ...after, stillWorkingSent: true })
  }
}

async function answerPeeks($: $, now: number) {
  const disk = diskOf($)
  const names = await disk.list(`${app.base}/peek/asks`)
  const asks: PeekAsk[] = []
  for (const n of names) {
    try {
      asks.push(JSON.parse((await disk.read(`${app.base}/peek/asks/${n}`)) ?? "") as PeekAsk)
    } catch {
      // a half-written ask: next tick
    }
  }
  for (const a of asksFor(app.sessionId, asks, now)) {
    if (tick.answering.has(a.id) || (await disk.read(`${app.base}/peek/replies/${a.id}.json`))) continue
    tick.answering.add(a.id)
    const r = await $.model.fork({ prompt: a.question }).catch(() => undefined)
    const text = r?.isAnswered ? r.text : `(could not answer: ${r?.reason ?? "error"})`
    await disk.write(`${app.base}/peek/replies/${a.id}.json`, JSON.stringify({ id: a.id, text }))
  }
}

async function setupOnce($: $) {
  if (tick.isSetupChecked || !app.isInteractive) return
  tick.isSetupChecked = true
  const disk = diskOf($)
  if ((await stateOf($).loadStrategy()) !== undefined || (await disk.read(`${app.base}/setup-asked`)) !== undefined) return
  // Written before the prompt goes, so a session starting next does not ask too.
  await disk.write(`${app.base}/setup-asked`, String(app.now))
  tick.notes.push(setupPrompt())
}

// What waits goes to the session as one prompt, only when its prompt box is empty;
// the engine holds a submitted prompt until the session is free.
async function deliver($: $) {
  if (tick.isWaking || (tick.notes.length === 0 && tick.pending.size === 0)) return
  if ((await $.prompt.read()).text.trim() !== "") return
  const state = stateOf($)
  const strategy = await strategyText($)
  const waiting = [...tick.pending.values()]
  const roster = waiting.some((w) => w.thread.isIncoming) ? await peers($) : []
  const parts = [...tick.notes]
  tick.notes = []
  tick.pending.clear()
  for (const { thread, posts } of waiting) {
    parts.push(thread.isIncoming ? incomingPrompt(thread, posts, strategy, roster) : replyPrompt(thread, posts, strategy))
    const after = (await state.loadThread(thread.rootId)) ?? thread
    const isEnded = posts.some((p) => isEnd(p.text, app.me?.name))
    // The root of a thread taken up is already counted; colleague replies count toward the 200.
    const counted = posts.filter((p) => p.id !== thread.rootId).length
    await state.saveThread({ ...after, seen: [...after.seen, ...posts.map((p) => p.id)], count: after.count + counted, lastAt: app.now, isClosed: after.isClosed || isEnded })
  }
  tick.isWaking = true
  void $.prompt.submit({ text: parts.join("\n\n---\n\n") }).finally(() => {
    tick.isWaking = false
  })
}

async function step($: $) {
  if (tick.isBusy) return
  tick.isBusy = true
  try {
    app.now = await $.clock.now()
    const now = app.now
    await answerPeeks($, now)
    if (!isSetUp()) return
    await setupOnce($)
    if (now >= tick.pausedUntil) {
      // Marked before trying, so a session not signed in tries once a poll, not every tick.
      const isPollDue = now - tick.lastPoll >= POLL_MS
      const isScanDue = app.isChat && now - tick.lastScan >= SCAN_MS
      if (isPollDue) tick.lastPoll = now
      if (isScanDue) tick.lastScan = now
      const me = isPollDue || isScanDue ? await signedInMe($) : undefined
      if (me !== undefined && isPollDue && now >= tick.pausedUntil) {
        await poll($, me, now)
        if (app.isChat) await stillWorking($, now)
      }
      if (me !== undefined && isScanDue && now >= tick.pausedUntil) await scan($, me, now)
    }
    await deliver($)
  } finally {
    tick.isBusy = false
  }
}

const TOOLS = [
  {
    name: "ask",
    description:
      "Ask one or more colleagues' Claude something in the team's agents channel in Teams: starts one thread @mentioning each of them. Their answers wake this session. Pass review true when your person's strategy says the question needs their review first.",
    inputSchema: {
      type: "object",
      properties: {
        people: { type: "array", items: { type: "string" }, description: "The colleagues' names or emails" },
        person: { type: "string", description: "One colleague's name or email (or use people)" },
        question: { type: "string" },
        review: { type: "boolean" },
      },
      required: ["question"],
    },
  },
  {
    name: "announce",
    description:
      "Post one message to everyone in the agents channel (@mentions the channel). Everyone is notified; no one's Claude answers it, so use ask for questions. Pass review true when your person's strategy says it needs their review.",
    inputSchema: { type: "object", properties: { text: { type: "string" }, review: { type: "boolean" } }, required: ["text"] },
  },
  {
    name: "reply",
    description: "Post in an agent chat thread you are in. Start the text with ✅ to end the thread. Pass review true when your person's strategy says it needs their review.",
    inputSchema: { type: "object", properties: { threadId: { type: "string" }, text: { type: "string" }, review: { type: "boolean" } }, required: ["threadId", "text"] },
  },
  {
    name: "read_thread",
    description: "Read an agent chat thread's posts.",
    inputSchema: { type: "object", properties: { threadId: { type: "string" } }, required: ["threadId"] },
  },
  {
    name: "peek",
    description: "Ask another Claude Code session on this Mac, by its name, what it is working on. It answers from its own context without being interrupted.",
    inputSchema: { type: "object", properties: { session: { type: "string" }, question: { type: "string" } }, required: ["session"] },
  },
  {
    name: "notify_person",
    description:
      "Get your person's attention when something needs their decision or answer (what the strategy says to bring to them, a review held for them): a Mac banner with a sound. One line: what is asked and what they need to decide.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "approve",
    description: "Post a draft held for review, once your person has said yes in this session.",
    inputSchema: { type: "object", properties: { draftId: { type: "string" } }, required: ["draftId"] },
  },
  {
    name: "strategy",
    description:
      "Read (action get) or save (action set, with text) your person's agent chat strategy: how to handle colleagues' questions. isDeclined true records that they chose not to set one.",
    inputSchema: { type: "object", properties: { action: { type: "string", enum: ["get", "set"] }, text: { type: "string" }, isDeclined: { type: "boolean" } }, required: ["action"] },
  },
  {
    name: "sign_in",
    description: "Sign your person in to Teams: gives a link and a code; call again once they have entered it.",
    inputSchema: { type: "object", properties: {} },
  },
]

export const register: Register = (on, options) => {
  on("session.start", async ($, e, next) => {
    const r = await next(e)
    app.now = await $.clock.now()
    const [sessionId, configDir, home] = await Promise.all([$.session.id(), $.env.get("CLAUDE_CONFIG_DIR"), $.env.get("HOME")])
    const claudeDir = configDir || `${home}/.claude`
    app.sessionId = sessionId
    app.home = home ?? ""
    app.cwd = e.cwd
    app.base = `${claudeDir}/${PLUGIN}`
    app.sessionsDir = `${claudeDir}/sessions`
    app.isChat = e.cwd === `${home}/agent-chat`
    app.isInteractive = e.isInteractive
    app.clientId = typeof options.clientId === "string" ? options.clientId.trim() : ""
    app.place = parseChannelLink(typeof options.channelLink === "string" ? options.channelLink : "")
    app.me = undefined
    app.signIn = undefined
    app.rate = createRate()
    app.humanSeq = 0
    app.tokenCache = {}
    app.isSignInAsked = false
    Object.assign(tick, { isBusy: false, lastPoll: 0, lastScan: 0, pausedUntil: 0, isWaking: false, isSetupChecked: false, answering: new Set(), missing: new Map(), notes: [], pending: new Map() })
    if (app.isChat && (await diskOf($).read(`${app.base}/scan-since`)) === undefined) await $.fs.write(`${app.base}/scan-since`, String(app.now))
    for (const t of TOOLS) await $.tool.register(t)
    app.stop?.()
    // The tick's promise goes back to the clock, so one finishes before the next starts.
    const timer = $.clock.every(TICK_MS, () => step($).catch((err) => $.ui.log(`teams-agent-chat: tick failed: ${err}`, { to: "debug" })))
    app.stop = () => timer.cancel()
    return r
  })

  on("prompt.submit", async ($, e, next) => {
    if ((e.origin.kind === "composer" || e.origin.kind === "bridge") && e.command === undefined) app.humanSeq += 1
    return next(e)
  })

  // The chat session handing a thread to another session: the clock for "still working on it".
  // Never in the way of the SendMessage itself, whatever goes wrong here.
  on("tool.call", { tool: "SendMessage" }, async ($, e, next) => {
    try {
      app.now = await $.clock.now()
      const thread = app.isChat ? String((e as unknown as { message?: unknown }).message ?? "").match(/\[thread ([^\]\s]+)\]/)?.[1] : undefined
      if (thread !== undefined) {
        const state = stateOf($)
        const t = await state.loadThread(thread)
        if (t !== undefined && !t.isClosed) await state.saveThread({ ...t, handoverAt: app.now, stillWorkingSent: undefined })
      }
    } catch (err) {
      $.ui.log(`teams-agent-chat: handover not recorded: ${err}`, { to: "debug" })
    }
    return next(e)
  })

  on("tool.call", { tool: new RegExp(`^${PREFIX}`) }, async ($, e) => {
    app.now = await $.clock.now()
    const tool = String((e as unknown as { tool: string }).tool).slice(PREFIX.length)
    try {
      return { result: await serve($, tool, e as unknown as Input) }
    } catch (err) {
      return { result: `teams-agent-chat failed: ${err instanceof Error ? err.message : String(err)}. Nothing was posted.` }
    }
  })
}
