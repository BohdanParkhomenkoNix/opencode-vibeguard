import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { PLACEHOLDER, startMockProvider, toolArgs, toolNames } from "../helpers/mock-provider.js"
import { makeProject, runOpencode } from "../helpers/opencode.js"

const MADE = "made.up.contact@botforge-e2e.io"
const REAL = "real.person@corp-e2e.io"
const CODE = `import pytest\n\n@pytest.fixture\ndef contact():\n    return "${MADE}"\n`
const COMPACTION_MARKER = /You MUST summarize the conversation above/
const mailConfig = (home) => ({ enabled: true, debug: true, key_file: path.join(home, "vg.key"), patterns: { builtin: ["email"] } })
const sessionId = () => `ses_vge2e${Date.now()}${Math.random().toString(36).slice(2, 6)}`
const shellName = (body) => toolNames(body).find((n) => n === "bash" || n === "shell")
const lastUserText = (body) => JSON.stringify([...body.messages].reverse().find((m) => m.role === "user") ?? {})
const summary = (ph) => ["Objective", "Requirements", "Decisions", "Work State", "Next Move", "Relevant Files", "Important Context"]
  .map((h) => `## ${h}\n${h === "Important Context" ? `The address is ${ph}` : "none"}`)
  .join("\n\n")

test("a value the model made up reaches the provider as written, and so does its read-back", async (t) => {
  const mock = await startMockProvider((body) => {
    if (!toolNames(body).includes("write")) return { text: "title" }
    const tools = body.messages.filter((m) => m.role === "tool").length
    if (tools === 0) return { tool: { name: "write", args: toolArgs(body, "write", { path: "notes.py", content: CODE }) } }
    if (tools === 1) return { tool: { name: "read", args: toolArgs(body, "read", { path: "notes.py" }) } }
    return { text: "done" }
  })
  t.after(() => mock.close())
  const base = makeProject(t, { baseURL: mock.baseURL, plugin: false })
  const project = makeProject(t, { baseURL: mock.baseURL, vibeguard: mailConfig(base.home) })
  const run = await runOpencode(project, "Write a pytest fixture file")
  assert.equal(run.code, 0, run.stderr.slice(-3000))
  assert.ok(!run.stderr.includes("guard=BLOCKED"), "the guard blocked a request")
  assert.equal(readFileSync(path.join(project.dir, "notes.py"), "utf8"), CODE)
  const afterTools = mock.requests.filter((r) => r.body?.messages?.some((m) => m.role === "tool"))
  assert.ok(afterTools.length >= 2, "no request after the tools ran")
  for (const r of afterTools) assert.ok(!/__VG_EMAIL_/.test(r.raw), "a value the model made up was masked")
  assert.ok(mock.requests.at(-1).raw.includes(MADE), "the read-back lacks the value")
})

test("a placeholder that only a compaction summary holds restores in a new process", async (t) => {
  let compacted = false
  const high = { prompt_tokens: 19000, completion_tokens: 50, total_tokens: 19050 }
  const mock = await startMockProvider((body) => {
    const raw = JSON.stringify(body?.messages ?? [])
    if (COMPACTION_MARKER.test(raw)) {
      compacted = true
      return { text: summary(raw.match(PLACEHOLDER)?.[0] ?? "NO_PLACEHOLDER") }
    }
    const shell = shellName(body)
    if (!shell) return { text: "title" }
    if (body.messages.at(-1).role === "tool") return { text: "done" }
    if (lastUserText(body).includes("out3.txt")) {
      return { tool: { name: shell, args: toolArgs(body, shell, { command: `printf '%s' '${raw.match(PLACEHOLDER)?.[0] ?? "NO_PLACEHOLDER"}' > out3.txt` }) } }
    }
    return compacted ? { text: "noted" } : { text: "noted", usage: high }
  })
  t.after(() => mock.close())
  const base = makeProject(t, { baseURL: mock.baseURL, plugin: false })
  const project = makeProject(t, { baseURL: mock.baseURL, vibeguard: mailConfig(base.home), contextLimit: 20000 })
  const session = sessionId()
  assert.equal((await runOpencode(project, `My address is ${REAL}.`, { session })).code, 0)
  const second = await runOpencode(project, "Anything else?", { session })
  assert.equal(second.code, 0, second.stderr.slice(-3000))
  assert.ok(compacted, "no compaction request seen")
  const third = await runOpencode(project, "Write the address to out3.txt", { session })
  assert.equal(third.code, 0, third.stderr.slice(-3000))
  const writer = mock.requests.find((r) => r.raw.includes("out3.txt") && shellName(r.body))
  assert.ok(writer, "no request asked for out3.txt")
  assert.ok(!writer.raw.includes("My address is"), "the original message is still in the history, so the test proves nothing")
  assert.equal(readFileSync(path.join(project.dir, "out3.txt"), "utf8"), REAL)
  for (const [i, r] of mock.requests.entries()) assert.ok(!r.raw.includes(REAL), `request ${i} leaks the address`)
})

test("a subagent receives a value its parent made up, unmasked", async (t) => {
  const mock = await startMockProvider((body) => {
    const shell = shellName(body)
    if (!shell) return { text: "title" }
    if (body.messages.at(-1).role === "tool") return { text: "done" }
    const raw = JSON.stringify(body.messages)
    if (raw.includes("You are a subagent spawned")) {
      return { tool: { name: shell, args: toolArgs(body, shell, { command: `printf '%s' '${raw.includes(MADE) ? MADE : "MASKED"}' > sub2.txt` }) } }
    }
    if (toolNames(body).includes("subagent")) {
      return { tool: { name: "subagent", args: toolArgs(body, "subagent", { agent: "general", description: "mail", prompt: `Write ${MADE} to sub2.txt` }) } }
    }
    return { text: "no subagent tool" }
  })
  t.after(() => mock.close())
  const base = makeProject(t, { baseURL: mock.baseURL, plugin: false })
  const project = makeProject(t, { baseURL: mock.baseURL, vibeguard: mailConfig(base.home) })
  const run = await runOpencode(project, "Delegate the mail")
  assert.equal(run.code, 0, run.stderr.slice(-3000))
  assert.equal(readFileSync(path.join(project.dir, "sub2.txt"), "utf8"), MADE)
  for (const [i, r] of mock.requests.entries()) assert.ok(!/__VG_EMAIL_/.test(r.raw), `request ${i} masks the made-up value`)
})
