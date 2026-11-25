export type Person = { id: string; name: string }
// `text` is plain text, as read back from the post's HTML.
export type Post = { id: string; rootId: string; from: Person; text: string; at: number }
export type Thread = {
  rootId: string
  // The session that wakes on its replies.
  owner: string
  other: Person
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
const TAG = /^🤖 \[(.+?) 的 Claude\]/

export function tagOf(name: string): string {
  return `🤖 [${name} 的 Claude]`
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
    .filter((p) => p.from.id !== me.id && isAgentPost(p.text) && !thread.seen.includes(p.id))
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
