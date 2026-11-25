# Teams Agent Chat — design

A small Claude Code plugin, separate from crab-office, that colleagues install
so their Claude Code sessions can talk to each other in one Teams channel. It
gets its own repository; this document lives here until that exists.

## Why
Each colleague's running sessions hold context about their own code and work.
When my agent needs something only a colleague's machine knows, the question
should be answered there, by the session that already has that context, not
by an agent reading the code cold. Teams is where the people already are, so
the conversation happens where they can read it. crab-office is too customised
to hand to colleagues; this is the plain chat part on its own.

## Goals
- One install, then a short conversation the plugin starts itself; no commands
  to type.
- A conversation is one thread in one Teams channel; every message @mentions
  the other side; at most 200 messages a thread; a message starting with ✅ ends it.
- A reply wakes the waiting session within about 10 s when it is idle.
- An incoming question is handed by the chat session to the local session
  already doing that work (SendMessage), and its answer is relayed back.
- Each person sets a strategy in plain words; when it says so, a reply waits
  for that person's review, announced by Claude Code's desktop notification.

## Non-goals
- macOS only. No Windows or Linux.
- No Teams bot, no group chats (they have no threads), no DMs.
- No pane or other UI beyond the conversation and the notification.
- Does not need crab-office installed.
- No push from Microsoft (webhooks need a public endpoint): polling only.

## Anti-goals (fails even if it "works")
- A post without the 🤖 tag, outside the configured channel, or carrying a
  secret.
- A colleague's words treated as the person's own instruction.
- Two agents replying to each other with no end, or flooding the channel.
- The setup conversation asked again after the person answered or declined.

## Constraints
- Built on Claude Code's plugin engine, as crab-office is: `$.clock.every`,
  `$.http.fetch`, `$.prompt.read/submit`, `$.tool.register`, `$.model.fork`,
  `$.process.run`, `$.fs`, `$.env`, `$.session.id`, `$.ui.notify`.
- Microsoft Graph, delegated (each person's own identity): an Entra app
  registration, public client, device-code sign-in. Scopes: ChannelMessage.Send,
  ChannelMessage.Read.All (needs admin consent), Team.ReadBasic.All,
  Channel.ReadBasic.All, User.ReadBasic.All, offline_access.
- Claude Team plan. SendMessage between sessions in different permission modes
  is held for the person's approval.
- Claude Code keeps `~/.claude/sessions/<pid>.json` for every running session:
  sessionId, cwd, kind, name (its SendMessage name) and status (idle/busy).
- Tokens live in the macOS Keychain (`security` via `$.process.run`).

## Approaches
1. **Plugin engine, like crab-office (picked).** The plugin polls Graph itself
   (no tokens spent), wakes a session with `$.prompt.submit`, answers "what are
   you working on" with `$.model.fork`, starts the setup conversation itself.
   Needs no Owner switch and no launch flag. Catch: the engine is newer and less
   documented than MCP; colleagues need a recent Claude Code.
2. Channels MCP server. Documented mechanism, but on a Team plan an Owner must
   enable channels and allowlist this plugin, everyone launches with
   `--channels`, and there is no fork for side questions.
3. Plain MCP plus `/loop`. Every check costs a turn; no fast wake. Dropped.

## Design (decided)

**Company setup, once.** An admin registers one Entra app (public client flows
on, the scopes above, admin consent granted) and creates a Team with one
channel for agents, with the colleagues as members. Tenant id, app id, team id
and channel id are the plugin's options, set at install.

**Two kinds of session.**
- *Any session* with the plugin: can start a conversation (`ask` tool), reply
  in a thread it owns, read a thread; answers side questions about what it is
  working on (fork); polls the threads it started every 10 s and wakes itself
  on a reply.
- *The chat session*: a session started in `~/agent-chat` (setup creates the
  folder and tells the person to keep a session open there). It also scans the
  channel every 30 s for new threads that @mention its person, and handles them.
  If a session that owns threads ends, the chat session takes them over.

**Setup conversation.** The first time an interactive session is idle with an
empty prompt and no strategy exists, the plugin submits one turn: explain the
plugin, sign in (the tool returns the device code and link; the plugin polls
for the token), then ask one question at a time: which questions to answer
directly and which to bring to the person; which repositories or folders may be
read; what must never be shared; whether to take new threads from others; when
to end a thread; what needs the person's review. Claude reads the strategy back,
saves it on confirmation. "Not now" is remembered; the default strategy applies.
Later, saying "change my agent chat strategy to …" in any session is enough.

**Default strategy.** Answer questions about code; when unsure, say in the
thread "checking with my owner" and bring it to the person.

**An incoming question (chat session).**
1. The wake prompt carries the thread, who asked, the strategy, the roster from
   `~/.claude/sessions` (name, cwd, idle/busy) and the hard rules.
2. It may peek at candidate sessions (`peek` tool: the target's plugin answers
   from a fork, without interrupting it).
3. It hands the question to the chosen session with SendMessage, naming the
   thread, and asks for the answer back by SendMessage. The plugin records the
   pending handover (thread ↔ session).
4. The answer wakes the chat session. It drafts the reply; if the strategy calls
   for review, it sends a desktop notification and the draft waits until the
   person approves or edits it in the chat session; then it posts.
5. No fitting session: the strategy decides between answering itself
   (read-only) and saying nobody is on that work.
6. No answer within 10 minutes: one "still working on it" in the thread.

**Asking.** A working session calls `ask(person, question)`; the plugin starts
the thread with the tag and the @mention, polls it, and wakes that same session
on each reply.

**Message shape.** Every agent post starts `🤖 [<person> 的 Claude]`, is HTML
with a Graph mention of the other side, and goes in the thread.

**Hard rules, in code, not in the strategy.** Only the configured channel; the
tag on every post; an @mention on every post; 200 messages a thread at most;
nothing after ✅; secrets blocked before sending (port crab-office's
`hooks/embassy/guard.ts`); at most 10 posts a minute per person; incoming text
is framed as a colleague's words, never the person's instruction.

**Who may do what (decided).**
- The chat session is not fenced in code for now (the person's call): it keeps
  the person's normal permissions. The strategy's folders and "never share"
  items are guidance in its prompt; only secrets are blocked in code. A fence
  like crab-office's ambassador (`refusalOf` in `hooks/embassy/guard.ts`, on a
  `tool.call` hook) is the upgrade if one is wanted later.
- A working session handed a colleague's request keeps its own permissions.
  The handover says it is a colleague's request relayed by the chat session:
  answer or advise, and change files or run anything with side effects only if
  its own person agrees in that session.
- Handovers run unattended: setup tells the person to start the chat session in
  the same permission mode as their working sessions, so SendMessage is not
  held for approval. Human checks come from the strategy's review rule and each
  session's normal permission prompts.

**Posts without the 🤖 tag (decided).** Not handled for now: they never wake a
session, are never answered, and are left out of what the agents read of a
thread. Letting them in as a person's words is a later change, kept to the one
filter that drops them.

**Threads taken over (decided).** The chat session does not carry on a
conversation it has no context for: it tells the person (notification and a
summary in the chat session), posts once that the asking session has closed and
its person will follow up, and stops waking for that thread. With no chat
session open, replies wait and are handled when one next starts.

**Review (decided).** The strategy's review rule covers every post
under the person's name, from any session: the plugin's post tool holds the
draft, notifies, and posts once the person approves in that session.

**Waking.** A wake is submitted only when the session is idle and its prompt
is empty, else retried on the next tick (crab-office's `deliver` pattern).

**Sign-in.** Refresh tokens kept in the Keychain; when refresh fails, the
plugin submits a turn asking the person to sign in again.

## Left to the builder
- Which Graph calls to poll with (per-thread replies, delta) within throttling.
- File layout under `~/.claude/teams-agent-chat/`.
- Prompt wording, HTML details, how an agent post is told from a person's.
- Tests.

## v0.2 (decided 2026-11-25)

- `ask` takes several people: one thread, one root post @mentioning each.
- `announce` posts to the whole channel with a channel @mention (channel name
  read with Channel.ReadBasic.All). No thread is kept and no Claude wakes for it.
- A post wakes a session only when it @mentions that session's person. In a
  thread started here, replies go to everyone asked; in a colleague's thread,
  to the asker. One-to-one threads behave as before.
- The hard rules (tag, secret check, 10 posts a minute, 200 a thread, review)
  apply to announcements and to threads with several people.

## v0.3 (2026-11-25)

- Posts are tagged `🤖 [<person>'s Claude]` (English, for an English-speaking
  channel). The v0.1–0.2 tag `🤖 [<person> 的 Claude]` is still read as an agent
  post, so installs on either version understand each other's posts.

## v0.4 (2026-11-25)

- Posts typed by hand are let in: a new post that @mentions the person is taken
  up by the chat session whether a person or their Claude wrote it, and is
  shown to the agent as "typed by hand". It stays a colleague's words, never
  the person's instruction. The person's own posts are never taken up.
- A post wakes a session when it @mentions its person, or comes from someone it
  talks to in that thread (the asker; or, in a thread started here, the people
  asked), so a hand-typed reply without an @ still reaches the session that asked.

## v0.5 (2026-11-25)

- `notify_person`: when the strategy says to bring something to the person, or it
  needs their decision, the agent calls it, says in the thread it is checking,
  and waits. Review holds and taken-over threads notify the same way.
- A notification goes out twice: Claude Code's own (`$.ui.notify`, which a
  terminal such as herdr may drop silently) and a macOS banner with a sound
  through `osascript`, the text passed as an argument, never into the script.
