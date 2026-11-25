import { expect, test } from "claude-code/testing"

import { secretsIn } from "../hooks/guard.ts"

test("keys and tokens are found in a message, and an ordinary one passes", () => {
  expect(secretsIn("token: ghp_" + "a".repeat(36))).not.toHaveLength(0)
  expect(secretsIn("use sk-ant-api03-" + "x".repeat(40))).not.toHaveLength(0)
  expect(secretsIn("AKIAIOSFODNN7EXAMPLE")).not.toHaveLength(0)
  expect(secretsIn("-----BEGIN OPENSSH PRIVATE KEY-----")).not.toHaveLength(0)
  expect(secretsIn("password = hunter2hunter2")).not.toHaveLength(0)
  expect(secretsIn("The user_id field is required and the token expiry is 15 minutes.")).toHaveLength(0)
  expect(secretsIn("我们周三前把接口文档发给你们")).toHaveLength(0)
})
test("a connection string with a password in it is caught on the way out", () => {
  expect(secretsIn("DATABASE_URL=postgres://app:s3cretpw@db.internal:5432/main")).not.toHaveLength(0)
  expect(secretsIn("see https://docs.example.com/api/users for the fields")).toHaveLength(0)
})
