import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { PLACEHOLDER, startMockProvider, toolArgs, toolNames } from "../helpers/mock-provider.js"
import { makeProject, runOpencode } from "../helpers/opencode.js"

const TASK_TOOL = "subagent"
const SUBAGENT = "general"
const COMPACTION_MARKER = /You MUST summarize the conversation above/
const SUMMARY = ["Objective", "Requirements", "Decisions", "Work State", "Next Move", "Relevant Files", "Important Context"]
  .map((h) => `## ${h}\nnone`)
  .join("\n\n")
const sessionId = () => `ses_vge2e${Date.now()}${Math.random().toString(36).slice(2, 6)}`

const SECRET = "vg-session-5Tn8Rc"
const config = (home) => ({ enabled: true, key_file: path.join(home, "vg.key"), patterns: { keywords: [{ value: SECRET, category: "test" }] } })
const shellName = (body) => toolNames(body).find((n) => n === "bash" || n === "shell")
const lastUserText = (body) => JSON.stringify([...body.messages].reverse().find((m) => m.role === "user") ?? {})

function assertClean(mock) {
  for (const [i, r] of mock.requests.entries()) assert.ok(!r.raw.includes(SECRET), `request ${i} leaks the secret`)
}

test("a subagent gets the value its parent hid", async (t) => {
  const mock = await startMockProvider((body) => {
    const shell = shellName(body)
    if (!shell) return { text: "title" }
    if (body.messages.at(-1).role === "tool") return { text: "done" }
    const user = lastUserText(body)
    const ph = user.match(PLACEHOLDER)?.[0] ?? "NO_PLACEHOLDER"
    if (user.includes("sub.txt")) return { tool: { name: shell, args: toolArgs(body, shell, { command: `printf '%s' '${ph}' > sub.txt` }) } }
    if (toolNames(body).includes(TASK_TOOL)) {
      return { tool: { name: TASK_TOOL, args: toolArgs(body, TASK_TOOL, { agent: SUBAGENT, description: "write", prompt: `Write ${ph} to sub.txt` }) } }
    }
    return { text: "no task tool" }
  })
  t.after(() => mock.close())
  const base = makeProject(t, { baseURL: mock.baseURL, plugin: false })
  const project = makeProject(t, { baseURL: mock.baseURL, vibeguard: config(base.home) })
  const run = await runOpencode(project, `Secret is ${SECRET}. Delegate it.`)
  assert.equal(run.code, 0, run.stderr.slice(-3000))
  assertClean(mock)
  assert.equal(readFileSync(path.join(project.dir, "sub.txt"), "utf8"), SECRET)
})

test("compaction requests are clean too", async (t) => {
  const usage = { prompt_tokens: 19000, completion_tokens: 50, total_tokens: 19050 }
  const mock = await startMockProvider((body) => {
    if (COMPACTION_MARKER.test(JSON.stringify(body?.messages ?? []))) return { text: SUMMARY, usage }
    return { text: "noted", usage }
  })
  t.after(() => mock.close())
  const base = makeProject(t, { baseURL: mock.baseURL, plugin: false })
  const project = makeProject(t, { baseURL: mock.baseURL, vibeguard: config(base.home), contextLimit: 20000 })
  const session = sessionId()
  assert.equal((await runOpencode(project, `Remember ${SECRET}.`, { session })).code, 0)
  const second = await runOpencode(project, "And now?", { session })
  assert.equal(second.code, 0, second.stderr.slice(-3000))
  const compaction = mock.requests.filter((r) => COMPACTION_MARKER.test(r.raw))
  assert.ok(compaction.length > 0, "no compaction request seen")
  assert.ok(compaction.some((r) => r.raw.includes("__VG_TEST_")), "compaction request lacks the placeholder")
  assertClean(mock)
})

test("a new process continues the session with the same placeholder", async (t) => {
  const seen = []
  const mock = await startMockProvider((body) => {
    const shell = shellName(body)
    if (!shell) return { text: "title" }
    const ph = JSON.stringify(body.messages).match(PLACEHOLDER)?.[0]
    if (ph) seen.push(ph)
    if (body.messages.at(-1).role === "tool") return { text: "done" }
    if (lastUserText(body).includes("out2.txt")) return { tool: { name: shell, args: toolArgs(body, shell, { command: `printf '%s' '${ph}' > out2.txt` }) } }
    return { text: "ok" }
  })
  t.after(() => mock.close())
  const base = makeProject(t, { baseURL: mock.baseURL, plugin: false })
  const project = makeProject(t, { baseURL: mock.baseURL, vibeguard: config(base.home) })
  const session = sessionId()
  assert.equal((await runOpencode(project, `Keep ${SECRET} in mind.`, { session })).code, 0)
  const second = await runOpencode(project, "Write it to out2.txt", { session })
  assert.equal(second.code, 0, second.stderr.slice(-3000))
  assert.equal(new Set(seen).size, 1, "placeholder changed between processes")
  assert.equal(readFileSync(path.join(project.dir, "out2.txt"), "utf8"), SECRET)
  assertClean(mock)
})
