import { expect, test } from "claude-code/testing"
import type { HttpInit, HttpResponse } from "claude-code"

import { SCOPES, createTokens, pollSignIn, startSignIn } from "../hooks/auth.ts"

const http = (status: number, json: unknown) => ({ status, ok: status < 300, headers: {}, text: JSON.stringify(json) }) as HttpResponse

test("the scopes are exactly the ones the admin consented to", async () => {
  expect(SCOPES).toBe("ChannelMessage.Send ChannelMessage.Read.All Team.ReadBasic.All Channel.ReadBasic.All User.ReadBasic.All offline_access")
})

test("sign-in asks for a device code with the app and the scopes", async () => {
  const sent: { url: string; init?: HttpInit }[] = []
  const fetch = async (url: string, init?: HttpInit) => {
    sent.push({ url, init })
    return http(200, { user_code: "ABCD-1234", device_code: "dc", verification_uri: "https://microsoft.com/devicelogin", interval: 5, expires_in: 900 })
  }
  const r = await startSignIn(fetch, "ten", "app", 1000)
  expect(r).toEqual({ userCode: "ABCD-1234", link: "https://microsoft.com/devicelogin", deviceCode: "dc", intervalS: 5, expiresAt: 901_000 })
  expect(sent[0]?.url).toBe("https://login.microsoftonline.com/ten/oauth2/v2.0/devicecode")
  const form = new URLSearchParams(sent[0]?.init?.body ?? "")
  expect(form.get("client_id")).toBe("app")
  expect(form.get("scope")).toBe(SCOPES)
})

test("waiting on the person is pending; their sign-in gives the tokens", async () => {
  expect(await pollSignIn(async () => http(400, { error: "authorization_pending" }), "ten", "app", "dc", 0)).toEqual({ status: "pending" })
  expect(await pollSignIn(async () => http(400, { error: "slow_down" }), "ten", "app", "dc", 0)).toEqual({ status: "pending" })
  expect(await pollSignIn(async () => http(400, { error: "expired_token" }), "ten", "app", "dc", 0)).toEqual({ status: "failed", reason: "expired_token" })
  expect(await pollSignIn(async () => http(200, { access_token: "A", refresh_token: "R", expires_in: 3600 }), "ten", "app", "dc", 1000)).toEqual({ status: "done", access: "A", refresh: "R", expiresAt: 3_601_000 })
})

test("the refresh token lives in the Keychain and is rotated on refresh; a refused refresh means signed out", async () => {
  const runs: string[][] = []
  let stored = ""
  const run = async (argv: string[]) => {
    runs.push(argv)
    if (argv[1] === "add-generic-password") stored = argv[argv.length - 1] ?? ""
    if (argv[1] === "find-generic-password") return stored ? { exitCode: 0, stdout: `${stored}\n` } : { exitCode: 44, stdout: "" }
    return { exitCode: 0, stdout: "" }
  }
  let answer = http(200, { access_token: "A2", refresh_token: "R2", expires_in: 3600 })
  const tokens = createTokens(async () => answer, run, "ten", "app", "ten/app", () => 0)
  expect(await tokens.isSignedIn()).toBe(false)
  await tokens.save("R1")
  expect(runs.find((a) => a[1] === "add-generic-password")).toEqual(["security", "add-generic-password", "-U", "-s", "teams-agent-chat", "-a", "ten/app", "-w", "R1"])
  expect(await tokens.isSignedIn()).toBe(true)
  expect(await tokens.get()).toBe("A2")
  expect(stored).toBe("R2")
  answer = http(400, { error: "invalid_grant" })
  const later = createTokens(async () => answer, run, "ten", "app", "ten/app", () => 0)
  expect(await later.get()).toBeUndefined()
})
