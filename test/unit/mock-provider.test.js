import { test } from "node:test"
import assert from "node:assert/strict"
import { startMockProvider, toolArgs, toolNames } from "../helpers/mock-provider.js"

async function post(baseURL, body) {
  const res = await fetch(`${baseURL}/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  })
  return res.text()
}

test("streams a text reply and records the request", async (t) => {
  const mock = await startMockProvider(() => ({ text: "pong" }))
  t.after(() => mock.close())
  const out = await post(mock.baseURL, { model: "mock", stream: true, messages: [{ role: "user", content: "ping" }] })
  assert.match(out, /"content":"pong"/)
  assert.match(out, /data: \[DONE\]/)
  assert.equal(mock.requests.length, 1)
  assert.equal(mock.requests[0].body.messages[0].content, "ping")
})

test("streams a tool call with JSON arguments", async (t) => {
  const mock = await startMockProvider(() => ({ tool: { name: "bash", args: { command: "echo hi" } } }))
  t.after(() => mock.close())
  const out = await post(mock.baseURL, { model: "mock", stream: true, messages: [] })
  assert.match(out, /"name":"bash"/)
  assert.match(out, /"finish_reason":"tool_calls"/)
  assert.ok(out.includes(JSON.stringify(JSON.stringify({ command: "echo hi" })).slice(1, -1)))
})

test("answers non-streaming requests with a JSON body", async (t) => {
  const mock = await startMockProvider(() => ({ text: "title" }))
  t.after(() => mock.close())
  const out = JSON.parse(await post(mock.baseURL, { model: "mock", messages: [] }))
  assert.equal(out.choices[0].message.content, "title")
})

test("toolArgs fills required fields the scenario did not set", () => {
  const body = { tools: [{ type: "function", function: { name: "bash", parameters: { required: ["command", "description"] } } }] }
  assert.deepEqual(toolNames(body), ["bash"])
  assert.deepEqual(toolArgs(body, "bash", { command: "ls" }), { command: "ls", description: "e2e" })
})
