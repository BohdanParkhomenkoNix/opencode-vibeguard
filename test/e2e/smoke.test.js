import { test } from "node:test"
import assert from "node:assert/strict"
import { startMockProvider } from "../helpers/mock-provider.js"
import { makeProject, runOpencode } from "../helpers/opencode.js"

test("opencode talks to the mock in an isolated home", async (t) => {
  const mock = await startMockProvider(() => ({ text: "pong-from-mock" }))
  t.after(() => mock.close())
  const project = makeProject(t, { baseURL: mock.baseURL, plugin: false })
  const run = await runOpencode(project, "ping")
  assert.equal(run.code, 0, run.stderr.slice(-2000))
  assert.ok(mock.requests.length >= 1)
  assert.match(run.stdout, /pong-from-mock/)
  assert.doesNotMatch(run.stderr, /SuperPowersLite|shadow-context/)
})
