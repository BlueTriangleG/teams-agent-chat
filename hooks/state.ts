import type { Person, Thread } from "./threads.ts"
import type { Strategy } from "./prompts.ts"

// Files under ~/.claude/teams-agent-chat, through the engine's $.fs (or a map in a test).
export type Disk = {
  read: (path: string) => Promise<string | undefined>
  write: (path: string, text: string) => Promise<void>
  list: (dir: string) => Promise<string[]>
}

export type Draft = { id: string; at: number; session: string; text: string; threadId?: string; to?: Person[]; isAnnounce?: true; isSent?: true }

const safe = (id: string) => id.replace(/[^\w.-]/g, "_")

async function json<T>(disk: Disk, path: string): Promise<T | undefined> {
  const text = await disk.read(path)
  if (!text) return undefined
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

export function createState(disk: Disk, base: string) {
  return {
    loadThread: (id: string) => json<Thread>(disk, `${base}/threads/${safe(id)}.json`),
    saveThread: (t: Thread) => disk.write(`${base}/threads/${safe(t.rootId)}.json`, JSON.stringify(t)),
    listThreads: async () => {
      const names = await disk.list(`${base}/threads`)
      const all = await Promise.all(names.map((n) => json<Thread>(disk, `${base}/threads/${n}`)))
      return all.filter((t): t is Thread => t !== undefined)
    },
    saveDraft: (d: Draft) => disk.write(`${base}/drafts/${safe(d.id)}.json`, JSON.stringify(d)),
    loadDraft: (id: string) => json<Draft>(disk, `${base}/drafts/${safe(id)}.json`),
    loadStrategy: () => json<Strategy>(disk, `${base}/strategy.json`),
    saveStrategy: (s: Strategy) => disk.write(`${base}/strategy.json`, JSON.stringify(s)),
  }
}

export type State = ReturnType<typeof createState>
