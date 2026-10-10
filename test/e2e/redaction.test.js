import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, statSync } from "node:fs"
import path from "node:path"
import { PLACEHOLDER, startMockProvider, toolArgs, toolNames } from "../helpers/mock-provider.js"
import { makeProject, runOpencode } from "../helpers/opencode.js"

const PROMPT_SECRET = "vg-prompt-7Qm2Xz"
const AGENTS_SECRET = "vg-agents-9Lk4Pw"
const FILE_TOKEN = `ghp_${"A1b2C3d4E5".repeat(4)}`
const SECRETS = [PROMPT_SECRET, AGENTS_SECRET, FILE_TOKEN]

const vibeguard = (home, extra = {}) => ({
  enabled: true,
  key_file: path.join(home, "vg.key"),
  patterns: { keywords: [{ value: PROMPT_SECRET, category: "test" }, { value: AGENTS_SECRET, category: "test" }], builtin: ["github_token"] },
  ...extra,
})

const shellName = (body) => toolNames(body).find((n) => n === "bash" || n === "shell")

function respond(body) {
  const shell = shellName(body)
  if (!shell) return { text: "Vibeguard e2e" }
  const last = body.messages.at(-1)
  if (last.role === "tool") return { text: "done" }
  const ph = JSON.stringify(last).match(PLACEHOLDER)?.[0] ?? "NO_PLACEHOLDER"
  return { tool: { name: shell, args: toolArgs(body, shell, { command: `cat secret.txt && printf '%s' '${ph}' > out.txt` }) } }
}

test("no secret reaches the provider and the shell gets the real value", async (t) => {
  const mock = await startMockProvider(respond)
  t.after(() => mock.close())
  const base = makeProject(t, { baseURL: mock.baseURL, plugin: false })
  const project = makeProject(t, {
    baseURL: mock.baseURL,
    vibeguard: vibeguard(base.home),
    files: { "AGENTS.md": `Staging password: ${AGENTS_SECRET}\n`, "secret.txt": `${FILE_TOKEN}\n` },
  })
  const run = await runOpencode(project, `My token is ${PROMPT_SECRET}. Run the shell.`)
  assert.equal(run.code, 0, run.stderr.slice(-3000))
  assert.ok(mock.requests.length >= 2, `requests: ${mock.requests.length}`)
  for (const [i, r] of mock.requests.entries()) {
    for (const secret of SECRETS) assert.ok(!r.raw.includes(secret), `request ${i} leaks a secret`)
  }
  const all = mock.requests.map((r) => r.raw).join("\n")
  assert.ok(new Set(all.match(/__VG_TEST_[0-9a-f]{12}__/g)).size >= 2, "prompt and AGENTS.md placeholders")
  assert.match(all, /__VG_GITHUB_TOKEN_[0-9a-f]{12}__/, "tool output placeholder")
  assert.equal(readFileSync(path.join(project.dir, "out.txt"), "utf8"), PROMPT_SECRET)
  assert.equal(statSync(path.join(base.home, "vg.key")).mode & 0o777, 0o600)
})

test("a broken config sends nothing to the provider", async (t) => {
  const mock = await startMockProvider(respond)
  t.after(() => mock.close())
  const base = makeProject(t, { baseURL: mock.baseURL, plugin: false })
  const project = makeProject(t, {
    baseURL: mock.baseURL,
    vibeguard: vibeguard(base.home, { patterns: { regex: [{ pattern: "(", category: "broken" }] } }),
  })
  const run = await runOpencode(project, `My token is ${PROMPT_SECRET}.`, { timeoutMs: 120000 })
  assert.equal(mock.requests.length, 0, "provider was called")
  assert.notEqual(run.code, 0)
  assert.match(run.stderr, /\[vibeguard\] setup failed/)
})
