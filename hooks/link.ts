export type Place = { tenantId: string; teamId: string; channelId: string }

// The link Teams gives under "Get link to channel":
// https://teams.microsoft.com/l/channel/<channel id, encoded>/<name>?groupId=<team>&tenantId=<tenant>
export function parseChannelLink(link: string): Place | undefined {
  let url: URL
  try {
    url = new URL(link.trim())
  } catch {
    return undefined
  }
  const [, l, kind, channel] = url.pathname.split("/")
  const teamId = url.searchParams.get("groupId")
  const tenantId = url.searchParams.get("tenantId")
  if (l !== "l" || kind !== "channel" || !channel || !teamId || !tenantId) return undefined
  return { tenantId, teamId, channelId: decodeURIComponent(channel) }
}
