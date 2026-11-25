export type Peer = { sessionId: string; name: string; cwd: string; status: string; kind: string }
export type PeekAsk = { id: string; to: string; question: string; at: number }
export type PeekReply = { id: string; text: string }

export const PEEK_WAIT_MS = 120_000
export const PEEK_QUESTION = "In two or three lines: what are you working on right now, in which repository and files?"

// Rows are the JSON of Claude Code's `~/.claude/sessions/*.json`, one per running session.
export function rosterOf(rows: unknown[]): Peer[] {
  return rows.flatMap((row) => {
    if (typeof row !== "object" || row === null) return []
    const r = row as Record<string, unknown>
    if (typeof r.sessionId !== "string" || typeof r.name !== "string" || r.name === "") return []
    return [{ sessionId: r.sessionId, name: r.name, cwd: String(r.cwd ?? ""), status: String(r.status ?? ""), kind: String(r.kind ?? "") }]
  })
}

export function asksFor(sessionId: string, asks: PeekAsk[], now: number): PeekAsk[] {
  return asks.filter((a) => a.to === sessionId && now - a.at < PEEK_WAIT_MS).sort((a, b) => a.at - b.at)
}
