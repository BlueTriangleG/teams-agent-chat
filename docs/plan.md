# Teams Agent Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone Claude Code plugin that lets colleagues' sessions talk in threads of one Teams channel, waking the right session on replies and handing incoming questions to the local session that has the context.

**Architecture:** A plugin-engine plugin (like crab-office): pure modules for link parsing, thread rules, Graph calls, sign-in, roster/peek and prompts, wired in one `register.tsx` that registers tools, polls Graph on `$.clock.every`, and wakes sessions with `$.prompt.submit`. No MCP server, no Channels.

**Tech Stack:** TypeScript on the Claude Code plugin engine (`claude-code`, `claude-code/testing`), Microsoft Graph v1.0 (delegated, device-code sign-in), macOS `security` for the Keychain.

**Spec:** `docs/superpowers/specs/2026-11-25-teams-agent-chat-design.md` (in the crab-office repo; copy it into the new repo in Task 1).

## Global Constraints

- New repository at `~/teams-agent-chat`; it must not import or require crab-office. Code ported from crab-office is copied, with its tests.
- macOS only.
- Plugin name `teams-agent-chat`; tools are `mcp__teams-agent-chat__<name>`.
- Options (`userConfig`, asked at install): `clientId` (the Entra Application ID) and `channelLink` (the Teams "Get link to channel" URL, which carries tenant, team and channel).
- Graph scopes, exactly: `ChannelMessage.Send ChannelMessage.Read.All Team.ReadBasic.All Channel.ReadBasic.All User.ReadBasic.All offline_access`.
- Every agent post starts `🤖 [<displayName> 的 Claude]`, is HTML, and @mentions the other side.
- Only posts starting with that tag are read, counted or woken on; untagged posts are dropped by one filter (`isAgentPost`).
- At most 200 agent posts a thread; a post whose text after the tag starts with `✅` closes it; nothing is posted or woken on after that.
- Poll owned open threads every 10 s; the chat session scans for new threads every 30 s.
- At most 10 posts a minute per person; secrets blocked before any post.
- The chat session is a session whose cwd is `~/agent-chat`.
- Plugin state lives under `~/.claude/teams-agent-chat/`; the refresh token only in the Keychain (service `teams-agent-chat`).
- 10 minutes after a handover with no reply posted: one "still working on it" post.
- Commit after each task only once the user has agreed to commits in this repo.

## Review Focus

- Graph answers 429: back off for `Retry-After` and resume, never hammer (test in Task 3 and Task 8).
- Several replies arrive while the session is busy or the Mac sleeps: one wake that carries all of them, not one wake each (test in Task 8).
- The owner session and the chat session both see a thread after a takeover: exactly one of them wakes per reply (test in Task 8).
- Refresh fails while nobody is at the Mac: polling pauses, one re-sign-in prompt, no loop of prompts (test in Task 8).
- Colleague HTML (code blocks, `<`, mentions) reads back as plain text, and our own `<`/`&` in code is escaped so a post never breaks (test in Task 3).

---

### Task 1: Scaffold, channel link, secret guard

**Files:**
- Create: `~/teams-agent-chat/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `hooks/hooks.json` (`{ "modules": ["./register.tsx"] }`), `tsconfig.json` (as crab-office's), `hooks/link.ts`, `hooks/guard.ts`, `hooks/register.tsx` (an empty `register` export for now), `docs/design.md` (the spec, copied)
- Test: `tests/link.test.ts`, `tests/guard.test.ts`

**Interfaces:**
- Produces: `type Place = { tenantId: string; teamId: string; channelId: string }`; `parseChannelLink(link: string): Place | undefined`; `secretsIn(text: string): string[]` (copied from crab-office `hooks/embassy/guard.ts:94` with the helpers it needs, nothing else from that file).

- [ ] **Step 1: Write the failing tests**

```ts
test("a Teams channel link gives the tenant, team and channel", async () => {
  const link = "https://teams.microsoft.com/l/channel/19%3Aabc123%40thread.tacv2/agent-chat?groupId=11111111-2222-3333-4444-555555555555&tenantId=66666666-7777-8888-9999-000000000000"
  expect(parseChannelLink(link)).toEqual({ channelId: "19:abc123@thread.tacv2", teamId: "11111111-2222-3333-4444-555555555555", tenantId: "66666666-7777-8888-9999-000000000000" })
  expect(parseChannelLink("https://teams.microsoft.com/l/chat/19%3Ax/0")).toBeUndefined()
  expect(parseChannelLink("not a link")).toBeUndefined()
})
```
Copy crab-office's `secretsIn` cases from `tests/embassy-guard.test.ts` into `tests/guard.test.ts` unchanged.

- [ ] **Step 2: Run** `claude plugin test .` — Expected: FAIL, `parseChannelLink` and `secretsIn` not found.
- [ ] **Step 3: Implement** `link.ts` with `URL` and `decodeURIComponent`; `plugin.json` with name `teams-agent-chat`, version `0.1.0`, the two `userConfig` strings; `marketplace.json` listing the plugin (as crab-office's does).
- [ ] **Step 4: Run** `claude plugin test .` and `claude plugin validate .` — Expected: PASS, manifest valid.
- [ ] **Step 5: Commit** `feat: scaffold, channel link and secret guard`.

### Task 2: Thread rules

**Files:**
- Create: `hooks/threads.ts`
- Test: `tests/threads.test.ts`

**Interfaces:**
- Produces:
  - `type Person = { id: string; name: string }`
  - `type Post = { id: string; rootId: string; from: Person; text: string; at: number }` (`text` is plain text)
  - `type Thread = { rootId: string; owner: string /* sessionId */; other: Person; count: number; isClosed: boolean; seen: string[]; isTakenOver?: true; handoverAt?: number; stillWorkingSent?: true }`
  - `tagOf(name: string): string` → `🤖 [${name} 的 Claude]`
  - `isAgentPost(text: string): boolean`
  - `isEnd(text: string): boolean` (after the tag, trimmed, starts with `✅`)
  - `newFor(thread: Thread, posts: Post[], me: Person): Post[]` (agent posts, not from `me`, not in `seen`, oldest first)
  - `canPost(thread: Thread): { ok: true } | { ok: false; reason: "closed" | "limit" }` (limit at `count >= 200`)
  - `createRate(limit = 10, windowMs = 60_000): { allow(now: number): boolean }`

- [ ] **Step 1: Write the failing tests**

```ts
test("only tagged posts from the other side are new, once", async () => {
  const me = { id: "u-me", name: "Gavin" }, alice = { id: "u-a", name: "Alice" }
  const t: Thread = { rootId: "r", owner: "s1", other: alice, count: 1, isClosed: false, seen: ["r"] }
  const posts = [
    { id: "p1", rootId: "r", from: alice, text: "🤖 [Alice 的 Claude] Alice cursor", at: 2 },
    { id: "p2", rootId: "r", from: alice, text: "typed by Alice herself", at: 3 },
    { id: "p3", rootId: "r", from: me, text: "🤖 [Gavin 的 Claude] thanks", at: 4 },
  ]
  expect(newFor(t, posts, me).map((p) => p.id)).toEqual(["p1"])
  expect(newFor({ ...t, seen: ["r", "p1"] }, posts, me)).toEqual([])
})
test("a thread takes 200 agent posts and nothing after ✅", async () => {
  const t = { rootId: "r", owner: "s", other: { id: "a", name: "A" }, count: 199, isClosed: false, seen: [] }
  expect(canPost(t)).toEqual({ ok: true })
  expect(canPost({ ...t, count: 200 })).toEqual({ ok: false, reason: "limit" })
  expect(canPost({ ...t, isClosed: true })).toEqual({ ok: false, reason: "closed" })
  expect(isEnd("🤖 [A 的 Claude] ✅ done")).toBe(true)
  expect(isEnd("🤖 [A 的 Claude] not ✅ yet")).toBe(false)
})
test("ten posts a minute, then the eleventh waits for the window", async () => {
  const rate = createRate()
  for (let i = 0; i < 10; i++) expect(rate.allow(1000 + i)).toBe(true)
  expect(rate.allow(1010)).toBe(false)
  expect(rate.allow(61_001)).toBe(true)
})
```

- [ ] **Step 2: Run** `claude plugin test .` — Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `hooks/threads.ts` to the interfaces above.
- [ ] **Step 4: Run** `claude plugin test .` — Expected: PASS.
- [ ] **Step 5: Commit** `feat: thread rules`.

### Task 3: Graph client

**Files:**
- Create: `hooks/graph.ts`
- Test: `tests/graph.test.ts`

**Interfaces:**
- Consumes: `Place` (Task 1); `Person`, `Post` (Task 2).
- Produces:
  - `type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; text: string; headers?: Record<string, string> }>`
  - `type Got<T> = { ok: true; value: T } | { ok: false; reason: "auth" | "rate" | "http"; status: number; retryAfterS?: number }`
  - `bodyOf(tag: string, to: Person, text: string): { body: { contentType: "html"; content: string }; mentions: unknown[] }` (content `${tag} <at id="0">${name}</at> ${escaped text}`, newlines as `<br>`; mention `{ id: 0, mentionText: name, mentioned: { user: { id, displayName: name, userIdentityType: "aadUser" } } }`)
  - `textOf(html: string): string` (strip tags, decode entities, `<br>`/`</p>` to newlines)
  - `createGraph(fetch: Fetch, token: () => Promise<string | undefined>, place: Place)` returning `{ me(): Promise<Got<Person>>; findUser(query: string): Promise<Got<Person[]>>; postRoot(b): Promise<Got<string>>; postReply(rootId: string, b): Promise<Got<string>>; replies(rootId: string): Promise<Got<Post[]>>; roots(): Promise<Got<(Post & { mentions: string[] })[]>> }`. Base `https://graph.microsoft.com/v1.0`; channel messages at `/teams/{teamId}/channels/{channelId}/messages`; `findUser` by display name prefix or mail. Which list queries `roots`/`replies` use is the implementer's call within throttling.

- [ ] **Step 1: Write the failing tests** (a fake `Fetch` records calls and returns canned JSON):
  - `bodyOf` of `if (a < b && c) {}` contains `if (a &lt; b &amp;&amp; c) {}` and the `<at id="0">Alice</at>` mention; `mentions[0].mentioned.user.id === "u-a"`.
  - `postReply("r", b)` sends `POST .../messages/r/replies` with `Authorization: Bearer t` and returns the new id.
  - A 401 gives `{ ok: false, reason: "auth", status: 401 }`; a 429 with `Retry-After: 7` gives `{ reason: "rate", retryAfterS: 7 }`.
  - `replies("r")` maps `from.user.id`, `body.content` through `textOf`, `createdDateTime` to ms; `textOf("<p>use <code>a&lt;b</code></p><p>ok</p>")` is `"use a<b\nok"`.
- [ ] **Step 2: Run** `claude plugin test .` — Expected: FAIL.
- [ ] **Step 3: Implement** `hooks/graph.ts`.
- [ ] **Step 4: Run** `claude plugin test .` — Expected: PASS.
- [ ] **Step 5: Commit** `feat: Graph client`.

### Task 4: Sign-in and tokens

**Files:**
- Create: `hooks/auth.ts`
- Test: `tests/auth.test.ts`

**Interfaces:**
- Consumes: `Fetch` (Task 3).
- Produces:
  - `SCOPES` (the exact string in Global Constraints)
  - `type Run = (argv: string[]) => Promise<{ exitCode: number; stdout: string }>`
  - `startSignIn(fetch, tenantId, clientId): Promise<{ userCode: string; link: string; deviceCode: string; intervalS: number; expiresAt: number } | { failed: string }>` (`POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/devicecode`, form `client_id`, `scope`)
  - `pollSignIn(fetch, tenantId, clientId, deviceCode): Promise<{ status: "pending" } | { status: "done"; access: string; refresh: string; expiresAt: number } | { status: "failed"; reason: string }>` (grant `urn:ietf:params:oauth:grant-type:device_code`; `authorization_pending` and `slow_down` are pending)
  - `createTokens(fetch, run, tenantId, clientId, account: string)` returning `{ get(): Promise<string | undefined>; save(refresh: string): Promise<void>; isSignedIn(): Promise<boolean> }`: `get` refreshes 5 minutes before expiry with the Keychain refresh token and stores the new one; it returns `undefined` when refresh fails.
  - Keychain via `security add-generic-password -U -s teams-agent-chat -a <account> -w <token>` and `security find-generic-password -s teams-agent-chat -a <account> -w`.

- [ ] **Step 1: Write the failing tests** with fake `fetch`/`run`:
  - `startSignIn` posts form fields `client_id=<id>` and the exact `SCOPES`, and returns the user code and `verification_uri` as `link`.
  - `pollSignIn` maps `{"error":"authorization_pending"}` to pending and a token answer to done.
  - `createTokens(...).save("R1")` runs the `add-generic-password` argv above; `get()` with no access token reads the Keychain, refreshes, saves the rotated refresh token, returns the access token; a refresh answered `invalid_grant` makes `get()` return `undefined`.
- [ ] **Step 2: Run** `claude plugin test .` — Expected: FAIL.
- [ ] **Step 3: Implement** `hooks/auth.ts`. Mark the argv exposure of the token to `security` with a `ponytail:` comment (ceiling: visible to local `ps` for the call's duration; upgrade: a keychain helper reading stdin).
- [ ] **Step 4: Run** `claude plugin test .` — Expected: PASS.
- [ ] **Step 5: Commit** `feat: device-code sign-in and Keychain tokens`.

### Task 5: Roster and peek files

**Files:**
- Create: `hooks/roster.ts`
- Test: `tests/roster.test.ts`

**Interfaces:**
- Produces:
  - `type Peer = { sessionId: string; name: string; cwd: string; status: string; kind: string }`
  - `rosterOf(rows: unknown[]): Peer[]` (rows are the JSON of `~/.claude/sessions/*.json`; malformed rows and rows without `name` or `sessionId` dropped)
  - `type PeekAsk = { id: string; to: string; question: string; at: number }`, `type PeekReply = { id: string; text: string }`
  - `asksFor(sessionId: string, asks: PeekAsk[], now: number): PeekAsk[]` (addressed to it, younger than 120 s, oldest first)
  - `PEEK_QUESTION` default text: "In two or three lines: what are you working on right now, in which repository and files?"

- [ ] **Step 1: Write the failing tests:** `rosterOf` keeps `{ sessionId, name, cwd, status, kind }` from a real-shaped row and drops `{}` and a row with no `name`; `asksFor` returns only the fresh asks addressed to it.
- [ ] **Step 2: Run** `claude plugin test .` — Expected: FAIL.
- [ ] **Step 3: Implement** `hooks/roster.ts`.
- [ ] **Step 4: Run** `claude plugin test .` — Expected: PASS.
- [ ] **Step 5: Commit** `feat: roster and peek files`.

### Task 6: Strategy and prompts

**Files:**
- Create: `hooks/prompts.ts`
- Test: `tests/prompts.test.ts`

**Interfaces:**
- Consumes: `Thread`, `Post`, `Person` (Task 2); `Peer` (Task 5).
- Produces:
  - `type Strategy = { text: string; isDeclined?: true; setAt: number }`
  - `DEFAULT_STRATEGY = "Answer questions about code. When unsure, say in the thread \"checking with my owner\" and bring it to your person."`
  - `HARD_RULES: string` (the spec's hard rules, in the model's words)
  - `setupPrompt(): string` — explain the plugin; call `sign_in`; ask one at a time the six spec questions (answer directly vs bring to the person; readable repositories/folders; never share; take new threads from others; when to end; what needs review); read the strategy back; save with `strategy` set; on "not now" save `isDeclined`; tell the person to keep a session open in `~/agent-chat` started in the same permission mode as their working sessions.
  - `incomingPrompt(thread: Thread, posts: Post[], strategy: string, roster: Peer[]): string` — the six steps of the spec's "An incoming question"; the handover text to send with SendMessage, containing `[thread ${rootId}]`, saying it is a colleague's request relayed by the chat session, to answer or advise and change nothing without its own person, and to answer back by SendMessage; the asker framed as a colleague, never the person.
  - `replyPrompt(thread: Thread, posts: Post[], strategy: string): string` — for the session that asked.
  - `takenOverText(): string`, `stillWorkingText(): string` (the post bodies after tag and mention).
  - `signInAgainPrompt(): string`.

- [ ] **Step 1: Write the failing tests:** `incomingPrompt` contains the strategy text, every roster name and cwd, `[thread r1]`, `SendMessage`, and the words "a colleague" and not "your person said"; `setupPrompt` contains each of the six question topics and `~/agent-chat`; `replyPrompt` includes every new post's text in order.
- [ ] **Step 2: Run** `claude plugin test .` — Expected: FAIL.
- [ ] **Step 3: Implement** `hooks/prompts.ts` (English).
- [ ] **Step 4: Run** `claude plugin test .` — Expected: PASS.
- [ ] **Step 5: Commit** `feat: strategy and prompts`.

### Task 7: Tools and the review gate

**Files:**
- Modify: `hooks/register.tsx`
- Create: `hooks/state.ts` (read/write `~/.claude/teams-agent-chat/threads/<rootId>.json`, `drafts/<id>.json`, `strategy.json`)
- Test: `tests/tools.test.ts` (engine harness: `test(name, async ($, on) => …)`, stubbing engine ops with `on(...)` as crab-office's `tests/ambassador.test.ts` does for HTTP)

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces: the tools `ask { person, question, review?: boolean }`, `reply { threadId, text, review?: boolean }`, `read_thread { threadId }`, `peek { session, question? }`, `approve { draftId }`, `strategy { action: "get" | "set", text?, isDeclined? }`, `sign_in {}`; `hooks/state.ts` exports `loadThread`, `saveThread`, `listThreads`, `saveDraft`, `loadDraft`, `loadStrategy`, `saveStrategy`.

- [ ] **Step 1: Write the failing tests:**
  - `ask` resolves the person, posts a root whose HTML starts with the tag and carries the mention, and saves a thread owned by this session.
  - `reply` with a text containing an AWS-style key is refused and nothing is posted; at `count` 200 it is refused with "limit"; the 11th post in a minute is refused.
  - `reply` (and `ask`) with `review: true` posts nothing, saves a draft, and calls `$.ui.notify`; `approve` of that draft is refused until a `prompt.submit` with origin `composer` or `bridge` (the person at the terminal or on their phone) arrives after the draft, then posts it.
  - `peek` writes an ask file for the named session and returns its reply text once the reply file appears (within 60 s; otherwise "no answer").
- [ ] **Step 2: Run** `claude plugin test .` — Expected: FAIL.
- [ ] **Step 3: Implement** at `session.start`: read options; `parseChannelLink`; `chat = cwd === ${home}/agent-chat`; register the seven tools; serve each with `on("tool.call", { tool: "mcp__teams-agent-chat__<name>" }, …)` returning `{ result }`. Every post path runs `canPost`, `secretsIn`, the rate limit, then `bodyOf` with `tagOf(me.name)` and the thread's other person; a post that `isEnd` closes the thread. Record the origin of each `prompt.submit` to gate `approve`.
- [ ] **Step 4: Run** `claude plugin test .` and `tsc -p .` — Expected: PASS, no type errors.
- [ ] **Step 5: Commit** `feat: tools and review gate`.

### Task 8: Polling, waking, setup and takeover

**Files:**
- Modify: `hooks/register.tsx`
- Test: `tests/wake.test.ts` (harness with `mock.clock`)

**Interfaces:**
- Consumes: Tasks 2–7.

- [ ] **Step 1: Write the failing tests:**
  - A tagged reply from the other side in an owned thread leads, within 10 s of mock time, to one `prompt.submit` in the owner session whose text contains the reply; an untagged post or our own tagged post leads to none.
  - Three replies arriving while the prompt box holds text give no submit; once it is empty, one submit carrying all three.
  - The chat session, within 30 s, claims a new root that is tagged and mentions its person (thread saved with it as owner) and submits `incomingPrompt`; a non-chat session never does.
  - A thread whose owner is not in the roster is taken over by the chat session: the next reply gives a notify and one `takenOverText` post, and no further wakes.
  - A `SendMessage` tool call from the chat session whose message contains `[thread r1]` records `handoverAt`; after 10 minutes with no post in `r1`, one `stillWorkingText` post, never two.
  - A 429 with `Retry-After: 30` pauses polling 30 s.
  - With no strategy, two sessions starting give one `setupPrompt` submit in total; a declined strategy gives none.
  - When `get()` returns `undefined`, polling stops and one `signInAgainPrompt` is submitted, not one per tick.
  - A peek ask addressed to this session is answered with `$.model.fork` and its reply file written.
- [ ] **Step 2: Run** `claude plugin test .` — Expected: FAIL.
- [ ] **Step 3: Implement** one `$.clock.every(1000)` tick: owned threads every 10 s, the chat session's root scan every 30 s, takeover, still-working, peek answers, setup once (an `asked` marker file written before the submit). Wakes go out with `void $.prompt.submit(...)` only when no wake is pending and `$.prompt.read()` is empty, as crab-office's `deliver` does (`register.tsx:606`); new posts are marked `seen` only when their wake is submitted. Watch `SendMessage` with `on("tool.call", { tool: "SendMessage" }, …)` calling `next(e)`.
- [ ] **Step 4: Run** `claude plugin test .` and `tsc -p .` — Expected: PASS, no type errors.
- [ ] **Step 5: Commit** `feat: polling, waking, setup and takeover`.

### Task 9: README and live check

**Files:**
- Create: `README.md` (what it does; the admin request: app registration, the scopes, admin consent, the Team and channel; install via `/plugin marketplace add <repo>` then install; the `~/agent-chat` session and its permission mode)

- [ ] **Step 1: Write** the README.
- [ ] **Step 2: Live check with the user** once the admin has set up the app and channel: load with `claude --plugin-dir ~/teams-agent-chat` in a working session and in `~/agent-chat`; go through setup; with a colleague (or a second account) installed the same way, `ask` from a working session, see the thread in Teams, the colleague's chat session hand it to their working session, and the answer wake the asking session; then a review-gated reply and its approval.
- [ ] **Step 3: Commit** `docs: README`.
