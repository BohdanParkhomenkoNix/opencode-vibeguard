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

test("a secret in one session is model-made in another where the model writes it first, across a restart", async (t) => {
  const mock = await startMockProvider((body) => {
    if (!toolNames(body).includes("write")) return { text: "title" }
    const prompt = lastUserText(body)
    const tools = body.messages.filter((m) => m.role === "tool").length
    if (prompt.includes("people.txt")) {
      return tools === 0 ? { tool: { name: "read", args: toolArgs(body, "read", { path: "people.txt" }) } } : { text: "done" }
    }
    if (prompt.includes("contact file")) {
      if (tools === 0) return { tool: { name: "write", args: toolArgs(body, "write", { path: "contact.txt", content: `contact ${REAL}\n` }) } }
      if (tools === 1) return { tool: { name: "read", args: toolArgs(body, "read", { path: "contact.txt" }) } }
      return { text: "done" }
    }
    return { text: "noted" }
  })
  t.after(() => mock.close())
  const base = makeProject(t, { baseURL: mock.baseURL, plugin: false })
  const project = makeProject(t, { baseURL: mock.baseURL, vibeguard: mailConfig(base.home), files: { "people.txt": `owner ${REAL}\n` } })
  const a = await runOpencode(project, "Read people.txt")
  assert.equal(a.code, 0, a.stderr.slice(-3000))
  const fromA = mock.requests.length
  for (const [i, r] of mock.requests.entries()) assert.ok(!r.raw.includes(REAL), `session A request ${i} leaks the address`)
  const sessionB = sessionId()
  const b = await runOpencode(project, "Write the contact file", { session: sessionB })
  assert.equal(b.code, 0, b.stderr.slice(-3000))
  assert.ok(!b.stderr.includes("guard=BLOCKED"), "the guard blocked a request in session B")
  const inB = mock.requests.slice(fromA).filter((r) => r.body?.messages?.some((m) => m.role === "tool"))
  assert.ok(inB.length >= 2, "no request after the tools ran in session B")
  for (const r of inB) assert.ok(!/__VG_EMAIL_/.test(r.raw), "session B masks the value its model wrote first")
  assert.ok(inB.at(-1).raw.includes(`contact ${REAL}`), "the read-back in session B lacks the value")
  const fromB = mock.requests.length
  const again = await runOpencode(project, "Anything else?", { session: sessionB })
  assert.equal(again.code, 0, again.stderr.slice(-3000))
  const afterRestart = mock.requests.slice(fromB).filter((r) => r.raw.includes("Anything else?") && toolNames(r.body).includes("write"))
  assert.ok(afterRestart.length >= 1, "no request after the restart")
  for (const r of afterRestart) {
    assert.ok(r.raw.includes(REAL), "after a restart the history lost the value")
    assert.ok(!/__VG_EMAIL_/.test(r.raw), "after a restart session B masks the value")
  }
})
