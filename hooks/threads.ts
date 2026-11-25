export type Person = { id: string; name: string }
// `text` is plain text, as read back from the post's HTML.
// `mentions`: the user ids the post @mentions, when known.
export type Post = { id: string; rootId: string; from: Person; text: string; at: number; mentions?: string[] }
export type Thread = {
  rootId: string
  // The session that wakes on its replies.
  owner: string
  // The asker in a thread taken up from a colleague; the first person asked in one started here.
  other: Person
  // Everyone asked, in a thread started here that asked several people.
  people?: Person[]
  // Agent posts in it so far, the root included.
  count: number
  isClosed: boolean
  seen: string[]
  // Started by a colleague and taken up by the chat session.
  isIncoming?: true
  isTakenOver?: true
  // Last post either way; a thread quiet for a day is no longer polled.
  lastAt?: number
  handoverAt?: number
  stillWorkingSent?: true
}

export const MAX_POSTS = 200
// Posts are tagged in English; the first release's Chinese tag still counts when read.
const TAG = /^🤖 \[(.+?)(?:'s Claude| 的 Claude)\]/

export function tagOf(name: string): string {
  return `🤖 [${name}'s Claude]`
}

// Who a post in this thread goes to: the asker, in a colleague's thread; everyone asked, in ours.
export function recipientsOf(thread: Thread): Person[] {
  return thread.isIncoming ? [thread.other] : (thread.people ?? [thread.other])
}

// Hand-written posts are left alone for now: this is the one filter that drops them.
export function isAgentPost(text: string): boolean {
  return TAG.test(text)
}

// `mentioned`: the name of the @mention that sits between tag and text in a post read back.
export function isEnd(text: string, mentioned?: string): boolean {
  let rest = text.replace(TAG, "").trim()
  if (mentioned !== undefined && rest.startsWith(mentioned)) rest = rest.slice(mentioned.length).trim()
  return rest.startsWith("✅")
}

export function newFor(thread: Thread, posts: Post[], me: Person): Post[] {
  return posts
    // Only posts that @mention this person: in a thread with several people asked, their
    // answers to the asker do not wake each other.
    .filter((p) => p.from.id !== me.id && isAgentPost(p.text) && !thread.seen.includes(p.id) && (p.mentions === undefined || p.mentions.includes(me.id)))
    .sort((a, b) => a.at - b.at)
}

export function canPost(thread: Thread): { ok: true } | { ok: false; reason: "closed" | "limit" } {
  if (thread.isClosed) return { ok: false, reason: "closed" }
  if (thread.count >= MAX_POSTS) return { ok: false, reason: "limit" }
  return { ok: true }
}

export function createRate(limit = 10, windowMs = 60_000): { allow(now: number): boolean } {
  let sent: number[] = []
  return {
    allow(now) {
      sent = sent.filter((t) => now - t < windowMs)
      if (sent.length >= limit) return false
      sent.push(now)
      return true
    },
  }
}
