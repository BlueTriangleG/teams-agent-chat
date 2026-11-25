import { expect, test } from "claude-code/testing"

import { parseChannelLink } from "../hooks/link.ts"

test("a Teams channel link gives the tenant, team and channel", async () => {
  const link =
    "https://teams.microsoft.com/l/channel/19%3Aabc123%40thread.tacv2/agent-chat?groupId=11111111-2222-3333-4444-555555555555&tenantId=66666666-7777-8888-9999-000000000000"
  expect(parseChannelLink(link)).toEqual({
    channelId: "19:abc123@thread.tacv2",
    teamId: "11111111-2222-3333-4444-555555555555",
    tenantId: "66666666-7777-8888-9999-000000000000",
  })
  expect(parseChannelLink("https://teams.microsoft.com/l/chat/19%3Ax/0")).toBeUndefined()
  expect(parseChannelLink("not a link")).toBeUndefined()
})

test("a link on Teams' newer teams.cloud.microsoft domain reads the same", async () => {
  const link =
    "https://teams.cloud.microsoft/l/channel/19%3AaB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5bC7dE9f%40thread.tacv2/agent-chat?groupId=22222222-3333-4444-5555-666666666666&tenantId=77777777-8888-9999-aaaa-bbbbbbbbbbbb"
  expect(parseChannelLink(link)).toEqual({
    channelId: "19:aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5bC7dE9f@thread.tacv2",
    teamId: "22222222-3333-4444-5555-666666666666",
    tenantId: "77777777-8888-9999-aaaa-bbbbbbbbbbbb",
  })
})
