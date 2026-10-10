# vibeguard V2 port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Форк `inkdust2021/opencode-vibeguard`, перенесённый на OpenCode V2: секреты заменяются плейсхолдерами `__VG_…__` во всех запросах к LLM и возвращаются в аргументы инструментов; плагин установлен в OC и проверен живьём.

**Architecture:** Ядро upstream (`engine`, `restore`, `session`, `patterns`, `config`) сохраняется, к нему добавляются постоянный ключ (`key.js`), обход V2-структур (`messages.js`) и страж исходящих тел (`guard.js`). Новая точка входа `index.js` регистрирует V2-хуки: сессии `context/title/compaction/generate/http.request` и инструмента `execute.before`. Любая ошибка ведёт к отказу запроса. Проверка: юнит-тесты `node --test` плюс e2e с настоящим `opencode run --standalone` против локального мок-провайдера.

**Tech Stack:** JavaScript ESM, Node ≥ 20 (тесты), рантайм плагина — OpenCode V2 2.0.26; только встроенные модули `node:*`; GitHub Actions.

**Spec:** `/Users/bohdanp/Projects/opencode-vibeguard/docs/superpowers/specs/2026-10-10-vibeguard-v2-port-design.md`

## Global Constraints

- Репозиторий: `~/Projects/opencode-vibeguard`, форк `BohdanParkhomenkoNix/opencode-vibeguard`, ветка `v2-port`, затем merge в `main`.
- Внешние действия выполняются только после явного подтверждения пользователя: `gh repo fork`, каждый `git push`, создание и merge PR, правка `~/.config/opencode/*`, рестарт сервиса OC. Исполнитель останавливается и спрашивает. Это не ruling.
- Node ≥ 20. Без npm-зависимостей ни в рантайме, ни в тестах.
- ESM: `"type": "module"`, вход `src/index.js`, `export default { id: "vibeguard", setup }`.
- Запись плагина в OC: `opencode-vibeguard@git+https://github.com/BohdanParkhomenkoNix/opencode-vibeguard.git`. Имя до `@` совпадает с `name` в `package.json`; в спеке §7 было `vibeguard@…`, это уточнение.
- Плейсхолдер `__VG_<CATEGORY>_<hash12>__`; `hash12` — первые 12 hex-символов `HMAC-SHA256(key, original)`; при коллизии суффикс `_<N>`.
- Ключ: 32 байта, файл с правами `0600`, по умолчанию `~/.config/opencode/vibeguard.key`, путь переопределяется полем `key_file`.
- Сопоставление «плейсхолдер ↔ значение» одно на процесс (не на сессию).
- Хуки:
  - сессия `context`, `title`, `compaction`, `generate` — прячут секреты в `system` и `messages`;
  - сессия `http.request` — страж;
  - инструмент `execute.before` — восстанавливает значения во всех инструментах, кроме `websearch`.
- Fail-closed:
  - при ошибке в хуке запроса `system`/`messages` очищаются и бросается исключение;
  - страж и `execute.before` бросают исключение.
- Значение секрета никогда не попадает в текст ошибки, лог или вывод теста.
- Без конфига плагин ничего не делает; битый конфиг блокирует все запросы.
- Встроенные правила по умолчанию в глобальном конфиге: `openai_key`, `anthropic_key`, `github_token`, `aws_access_key`, `google_api_key`, `private_key`, `jwt`, `email`.
- Mutation: N/A — пользователь исключил мутационное тестирование.
- UI check: N/A — браузерного интерфейса нет.
- Архитектурное ревью плана не проводится (решение пользователя).

## Review Focus

1. Часть сообщения V2 — не простой объект, а экземпляр класса. Обход всё равно заменяет в нём строки (Задача 8, `test_class_instances_are_walked`).
2. Секрет с JSON-экранированием (кавычка, `\n` в приватном ключе) в теле запроса. Страж его ловит (Задача 9, `escaped secret is caught`).
3. Конфиг есть, но это битый JSON. Запросы блокируются, а текст ошибки не содержит содержимого файла (Задачи 7 и 10).
4. Плейсхолдер, которого нет в сопоставлении (придуман моделью или просрочен). Остаётся как есть, без исключения (Задача 10, `unknown placeholder is left alone`).
5. Повторная чистка истории, где уже есть плейсхолдеры. Текст не меняется, плейсхолдеры не вкладываются друг в друга (Задача 8, `redaction is idempotent`).

---

### Task 1: Форк, клон, каркас

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`
- Create: `docs/superpowers/specs/2026-10-10-vibeguard-v2-port-design.md` (копия)
- Create: `docs/superpowers/plans/2026-10-10-vibeguard-v2-port.md` (копия)
- Create: `test/helpers/tmp.js`
- Test: `test/unit/scaffold.test.js`

**Interfaces:**
- Consumes: —
- Produces: модули upstream в клоне, которые позже не переписываются: `redactText(text, patterns, session) -> { text, matches }` (`engine.js`), `restoreText(text, session) -> string` (`restore.js`), класс `PlaceholderSession` (`session.js`, меняет Задача 5); репозиторий в `~/Projects/opencode-vibeguard` на ветке `v2-port`; `npm test` (= `node --test test/unit/`); `npm run test:e2e` (= `node --test --test-concurrency=1 --test-timeout=300000 test/e2e/`); `tmpdir(t) -> string` (realpath, удаляется после теста), `withHome(t, dir) -> void` (подменяет `process.env.HOME` до конца теста).

- [ ] **Step 1: Спросить пользователя и создать форк**

Остановиться и получить «да» на `gh repo fork`. Затем:
```bash
gh repo fork inkdust2021/opencode-vibeguard --clone=false --default-branch-only
git clone https://github.com/BohdanParkhomenkoNix/opencode-vibeguard.git ~/Projects/opencode-vibeguard
cd ~/Projects/opencode-vibeguard && git checkout -b v2-port && git log --oneline -1
```
Expected: последний коммит upstream, ветка `v2-port`.

- [ ] **Step 2: Написать падающий тест каркаса**

`test/unit/scaffold.test.js`:
```js
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
import { tmpdir, withHome } from "../helpers/tmp.js"

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"))

test("package targets V2 and runs unit tests", () => {
  assert.equal(pkg.name, "opencode-vibeguard")
  assert.equal(pkg.type, "module")
  assert.equal(pkg.main, "./src/index.js")
  assert.equal(pkg.scripts.test, "node --test test/unit/")
  assert.match(pkg.engines.node, />=20/)
})

test("tmp helpers isolate HOME", (t) => {
  const dir = tmpdir(t)
  assert.ok(existsSync(dir))
  withHome(t, dir)
  assert.equal(process.env.HOME, dir)
})
```

- [ ] **Step 3: Запустить и убедиться, что падает**

Run: `node --test test/unit/`
Expected: FAIL — `Cannot find module '…/test/helpers/tmp.js'`.

- [ ] **Step 4: Каркас**

`test/helpers/tmp.js`:
```js
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

export function tmpdir(t) {
  const dir = mkdtempSync(path.join(realpathSync(os.tmpdir()), "vg-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

export function withHome(t, dir) {
  const previous = process.env.HOME
  process.env.HOME = dir
  t.after(() => {
    if (previous === undefined) delete process.env.HOME
    else process.env.HOME = previous
  })
}
```
`package.json` целиком:
```json
{
  "name": "opencode-vibeguard",
  "version": "0.2.0",
  "description": "OpenCode V2 plugin: replaces secrets with __VG_ placeholders before requests reach the LLM provider and restores them before tools run",
  "type": "module",
  "main": "./src/index.js",
  "exports": "./src/index.js",
  "files": ["src", "README.md", "vibeguard.config.json.example"],
  "scripts": {
    "test": "node --test test/unit/",
    "test:e2e": "node --test --test-concurrency=1 --test-timeout=300000 test/e2e/"
  },
  "keywords": ["opencode", "opencode-plugin", "vibeguard", "privacy", "redaction", "secrets"],
  "repository": { "type": "git", "url": "git+https://github.com/BohdanParkhomenkoNix/opencode-vibeguard.git" },
  "license": "MIT",
  "engines": { "node": ">=20" }
}
```
В `.gitignore` дописать строки `.superpowers/` и `node_modules/`, если их нет. Скопировать спеку и план:
```bash
mkdir -p docs/superpowers/specs docs/superpowers/plans
cp ~/.config/opencode/docs/superpowers/specs/2026-10-10-vibeguard-v2-port-design.md docs/superpowers/specs/
cp ~/.config/opencode/docs/superpowers/plans/2026-10-10-vibeguard-v2-port.md docs/superpowers/plans/
```

- [ ] **Step 5: Запустить тесты**

Run: `npm test`
Expected: PASS 2/2.

- [ ] **Step 6: Commit**

```bash
git add package.json .gitignore docs test
git commit -m "chore: V2 port scaffold, test helpers, spec and plan"
```

---

### Task 2: Мок OpenAI-совместимого провайдера

**Files:**
- Create: `test/helpers/mock-provider.js`
- Test: `test/unit/mock-provider.test.js`

**Interfaces:**
- Consumes: —
- Produces:
  - `startMockProvider(respond) -> Promise<{ baseURL: string, requests: Array<{ path, body, raw }>, close(): Promise<void> }>`, где `respond(body, requests) -> { text: string, usage? } | { tool: { name: string, args: object }, usage? }`;
  - `toolNames(body) -> string[]`;
  - `toolArgs(body, name, values) -> object` — дополняет обязательные поля схемы инструмента значением `"e2e"`;
  - `PLACEHOLDER = /__VG_[A-Z0-9_]+_[0-9a-f]{12}(?:_\d+)?__/g`.

- [ ] **Step 1: Написать падающий тест**

`test/unit/mock-provider.test.js`:
```js
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
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `node --test test/unit/mock-provider.test.js`
Expected: FAIL — `Cannot find module '…/mock-provider.js'`.

- [ ] **Step 3: Реализация**

`test/helpers/mock-provider.js`:
```js
import http from "node:http"

export const PLACEHOLDER = /__VG_[A-Z0-9_]+_[0-9a-f]{12}(?:_\d+)?__/g

let seq = 0

function sse(id, delta, finish = null, usage) {
  const chunk = {
    id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "mock",
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
  if (usage) chunk.usage = usage
  return `data: ${JSON.stringify(chunk)}\n\n`
}

export function toolNames(body) {
  return (body?.tools ?? []).map((t) => t?.function?.name ?? t?.name).filter(Boolean)
}

export function toolArgs(body, name, values) {
  const tool = (body?.tools ?? []).find((t) => (t?.function?.name ?? t?.name) === name)
  const required = tool?.function?.parameters?.required ?? tool?.parameters?.required ?? []
  const args = { ...values }
  for (const key of required) if (!(key in args)) args[key] = "e2e"
  return args
}

export async function startMockProvider(respond) {
  const requests = []
  const server = http.createServer((req, res) => {
    let raw = ""
    req.setEncoding("utf8")
    req.on("data", (d) => (raw += d))
    req.on("end", () => {
      if (req.method === "GET" && req.url.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" })
        return res.end(JSON.stringify({ object: "list", data: [{ id: "mock", object: "model" }] }))
      }
      if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
        res.writeHead(404)
        return res.end()
      }
      let body = null
      try { body = JSON.parse(raw) } catch {}
      requests.push({ path: req.url, body, raw })
      let reply
      try { reply = respond(body, requests) } catch (error) { reply = { text: `mock responder error: ${error.message}` } }
      const usage = reply.usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      const id = `chatcmpl-${++seq}`
      const call = reply.tool && { id: `call_${seq}`, type: "function", function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) } }
      if (!body?.stream) {
        const message = call ? { role: "assistant", content: null, tool_calls: [call] } : { role: "assistant", content: reply.text }
        res.writeHead(200, { "content-type": "application/json" })
        return res.end(JSON.stringify({
          id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: "mock",
          choices: [{ index: 0, message, finish_reason: call ? "tool_calls" : "stop" }], usage,
        }))
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
      if (call) {
        res.write(sse(id, { role: "assistant", tool_calls: [{ index: 0, id: call.id, type: "function", function: { name: call.function.name, arguments: "" } }] }))
        res.write(sse(id, { tool_calls: [{ index: 0, function: { arguments: call.function.arguments } }] }))
        res.write(sse(id, {}, "tool_calls", usage))
      } else {
        res.write(sse(id, { role: "assistant", content: reply.text }))
        res.write(sse(id, {}, "stop", usage))
      }
      res.end("data: [DONE]\n\n")
    })
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address()
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()) }),
  }
}
```

- [ ] **Step 4: Запустить тесты**

Run: `npm test`
Expected: PASS 6/6.

- [ ] **Step 5: Commit**

```bash
git add test/helpers/mock-provider.js test/unit/mock-provider.test.js
git commit -m "test: OpenAI-compatible mock provider for e2e"
```

---

### Task 3: Запуск opencode в изоляции и факты V2

**Files:**
- Create: `test/helpers/opencode.js`
- Create: `docs/v2-facts.md`
- Test: `test/e2e/smoke.test.js`

**Interfaces:**
- Consumes: `startMockProvider`, `PLACEHOLDER` (Задача 2); `tmpdir` (Задача 1).
- Produces:
  - `PLUGIN_ENTRY: string` — `file://` URL на `src/index.js`;
  - `makeProject(t, { baseURL, plugin = true, files = {}, vibeguard, contextLimit = 200000 }) -> { dir, home }`;
  - `runOpencode(project, message, { session, timeoutMs = 240000 } = {}) -> Promise<{ code, stdout, stderr }>`;
  - `docs/v2-facts.md` с ответами F1–F11 (ниже); Задачи 8, 11 и 12 читают их оттуда.

- [ ] **Step 1: Написать падающий smoke-тест**

`test/e2e/smoke.test.js`:
```js
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
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `node --test test/e2e/smoke.test.js`
Expected: FAIL — `Cannot find module '…/opencode.js'`.

- [ ] **Step 3: Реализация**

`test/helpers/opencode.js`:
```js
import { spawn } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "./tmp.js"

export const PLUGIN_ENTRY = new URL("../../src/index.js", import.meta.url).href

function isolatedEnv(home) {
  return {
    PATH: process.env.PATH,
    USER: process.env.USER,
    TMPDIR: process.env.TMPDIR,
    TERM: "dumb",
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
  }
}

export function makeProject(t, { baseURL, plugin = true, files = {}, vibeguard, contextLimit = 200000 }) {
  const root = tmpdir(t)
  const home = path.join(root, "home")
  const dir = path.join(root, "project")
  mkdirSync(home, { recursive: true })
  mkdirSync(dir, { recursive: true })
  const config = {
    $schema: "https://opencode.ai/config.json",
    share: "disabled",
    providers: {
      local: {
        name: "Mock",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL, apiKey: "mock" },
        models: { mock: { name: "Mock", limit: { context: contextLimit, output: 4096 } } },
      },
    },
    plugins: plugin ? [PLUGIN_ENTRY] : [],
  }
  writeFileSync(path.join(dir, "opencode.jsonc"), JSON.stringify(config, null, 2))
  if (vibeguard) writeFileSync(path.join(dir, "vibeguard.config.json"), JSON.stringify(vibeguard, null, 2))
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content)
  return { dir, home }
}

export function runOpencode(project, message, { session, timeoutMs = 240000 } = {}) {
  const args = ["run", "--standalone", "--print-logs", "--auto", "-m", "local/mock"]
  if (session) args.push("--session", session)
  args.push(message)
  return new Promise((resolve) => {
    const child = spawn("opencode", args, { cwd: project.dir, env: isolatedEnv(project.home), stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? "killed", stdout, stderr })
    })
  })
}
```

- [ ] **Step 4: Запустить smoke-тест**

Run: `node --test test/e2e/smoke.test.js`
Expected: PASS. Если изоляция через `HOME`/`XDG_*` не работает (глобальные плагины загрузились, opencode не стартует), нужно найти рабочую комбинацию переменных и записать её как Ruling. Если её нет, остановиться: e2e на общем конфиге загрузил бы второй экземпляр плагина после раскатки.

- [ ] **Step 5: Собрать факты V2 одноразовым зондом (не коммитится)**

Создать `/tmp/vg-probe/probe.js`:
```js
// THROWAWAY probe for docs/v2-facts.md — not committed.
import { appendFileSync } from "node:fs"
const LOG = process.env.VG_PROBE_LOG
const THROW = process.env.VG_PROBE_THROW ?? ""
const log = (tag, v) => appendFileSync(LOG, `${tag} ${JSON.stringify(v, (k, x) => (typeof x === "bigint" ? String(x) : x))}\n`)
export default {
  id: "vgprobe",
  async setup(ctx) {
    for (const name of ["context", "title", "compaction", "generate"]) {
      await ctx.session.hook(name, async (e) => {
        log(`${name}.event`, { keys: Object.keys(e), system: e.system, messages: e.messages,
          ctor: e.messages?.[0]?.constructor?.name, partCtor: e.messages?.at(-1)?.content?.[0]?.constructor?.name })
        console.error(`[vgprobe] hook ${name}`)
        if (THROW === name) throw new Error("vgprobe: blocked in " + name)
      })
    }
    await ctx.session.hook("http.request", async (e) => {
      log("http.request", { kind: e.kind })
      if (THROW === "http.request") throw new Error("vgprobe: blocked in http.request")
    })
    await ctx.tool.hook("execute.before", async (e) => log("execute.before", { tool: e.tool, input: e.input }))
  },
}
```
Временный тест-сценарий `/tmp/vg-probe/facts.test.js` импортирует `makeProject`, `runOpencode` и `startMockProvider` по абсолютным путям из клона. В `opencode.jsonc` проекта в `plugins` подставлен `file:///tmp/vg-probe/probe.js`: правка JSON после `makeProject(…, { plugin: false })`. Сценарий выполняет прогоны:
- (a) Мок на первый запрос с инструментами отвечает вызовом shell-инструмента (имя из `toolNames`), на запрос после результата — текстом. Записать в лог `body.tools` (имена и `parameters`) из запросов мока.
- (b) То же с `VG_PROBE_THROW=context`.
- (c) То же с `VG_PROBE_THROW=http.request`.
- (d) Мок вызывает инструмент субагента (имя из `toolNames`, похожее на `task`), субагент один раз вызывает shell.
- (e) `contextLimit: 3000`, мок отдаёт `usage.prompt_tokens: 2900`, затем второй прогон с той же `--session`; убедиться, что сработал хук `compaction`.
- (f) `--session ses_vgprobe<время>` на новом id.

Ответы записать в `docs/v2-facts.md`, по одной строке на факт, с доказательством из лога:
- F1: изоляция работает — в `--print-logs` нет `loading plugin` для глобальных плагинов.
- F2: `throw` в `context` прерывает запрос — мок не получил основной запрос в прогоне (b) — и код выхода/текст в stdout/stderr.
- F3: `throw` в `http.request` прерывает запрос — мок не получил ни одного запроса в (c).
- F4: точная форма `messages` и `system` в V2 — текст, рассуждение, вызов и результат инструмента; есть ли экземпляры классов (`ctor`, `partCtor`).
- F5: имя инструмента субагента для модели, его обязательные аргументы, значения `subagent_type`.
- F6: как вызвать compaction (поля `limit`, `usage`) и по какому признаку тело запроса compaction отличается от обычного.
- F7: формат id, который принимает `--session`.
- F8: есть ли `websearch` в `body.tools` у локального провайдера.
- F9: код выхода `opencode run` при отказе в хуке.
- F10: видна ли строка `console.error` плагина в stderr `--print-logs`.
- F11: имя shell-инструмента в `body.tools` (для модели) и в `event.tool` (`execute.before`).

Если F2 и F3 оба «нет», остановиться: спека §4 требует поправки и согласования. Если F2 «нет», а F3 «да», это допустимо: `block()` в Задаче 10 очищает запрос, страж его отклоняет. Записать как Ruling.

- [ ] **Step 6: Commit**

```bash
rm -rf /tmp/vg-probe
git add test/helpers/opencode.js test/e2e/smoke.test.js docs/v2-facts.md
git commit -m "test: isolated opencode runner, smoke e2e, recorded V2 facts"
```

---

### Task 4: Постоянный ключ

**Files:**
- Create: `src/key.js`
- Test: `test/unit/key.test.js`

**Interfaces:**
- Consumes: `tmpdir`, `withHome` (Задача 1).
- Produces: `KEY_BYTES = 32`; `defaultKeyFile() -> string`; `loadKey(file = defaultKeyFile()) -> Buffer` (32 байта; создаёт файл `0600` и каталог `0700`; иначе `Error` без содержимого ключа).

- [ ] **Step 1: Написать падающий тест**

`test/unit/key.test.js`:
```js
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { KEY_BYTES, defaultKeyFile, loadKey } from "../../src/key.js"
import { tmpdir, withHome } from "../helpers/tmp.js"

test("creates a 32-byte key readable only by the owner", (t) => {
  const file = path.join(tmpdir(t), "nested", "vibeguard.key")
  const key = loadKey(file)
  assert.equal(key.length, KEY_BYTES)
  assert.equal(statSync(file).mode & 0o777, 0o600)
})

test("reuses the key that is already there", (t) => {
  const file = path.join(tmpdir(t), "vibeguard.key")
  assert.deepEqual(loadKey(file), loadKey(file))
})

test("a key of the wrong length is an error", (t) => {
  const file = path.join(tmpdir(t), "vibeguard.key")
  writeFileSync(file, "short")
  assert.throws(() => loadKey(file), /must hold 32 bytes, found 5/)
})

test("an unreadable key path is an error", (t) => {
  const dir = path.join(tmpdir(t), "is-a-dir")
  mkdirSync(dir)
  assert.throws(() => loadKey(dir), /cannot read key file/)
})

test("default key lives in the OpenCode config dir", (t) => {
  const home = tmpdir(t)
  withHome(t, home)
  assert.equal(defaultKeyFile(), path.join(home, ".config", "opencode", "vibeguard.key"))
})
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `node --test test/unit/key.test.js`
Expected: FAIL — `Cannot find module '…/src/key.js'`.

- [ ] **Step 3: Реализация**

`src/key.js`:
```js
import { randomBytes } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

export const KEY_BYTES = 32

export function defaultKeyFile() {
  return path.join(os.homedir(), ".config", "opencode", "vibeguard.key")
}

/**
 * HMAC key shared by every session and every OpenCode restart, so a secret keeps its
 * placeholder across them. Created on first use with owner-only permissions.
 */
export function loadKey(file = defaultKeyFile()) {
  let key
  try {
    key = readFileSync(file)
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`cannot read key file ${file}: ${error.code}`)
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    try {
      writeFileSync(file, randomBytes(KEY_BYTES), { mode: 0o600, flag: "wx" })
    } catch (writeError) {
      // Another process created it first: use theirs.
      if (writeError.code !== "EEXIST") throw new Error(`cannot create key file ${file}: ${writeError.code}`)
    }
    chmodSync(file, 0o600)
    key = readFileSync(file)
  }
  if (key.length !== KEY_BYTES) throw new Error(`key file ${file} must hold ${KEY_BYTES} bytes, found ${key.length}`)
  return key
}
```

- [ ] **Step 4: Запустить тесты**

Run: `npm test`
Expected: PASS, все тесты.

- [ ] **Step 5: Commit**

```bash
git add src/key.js test/unit/key.test.js
git commit -m "feat: persistent 0600 HMAC key"
```

---

### Task 5: Общее сопоставление на процесс

**Files:**
- Modify: `src/session.js` (конструктор, новый метод `knownEntries`)
- Test: `test/unit/session.test.js`

**Interfaces:**
- Consumes: —
- Produces:
  - `new PlaceholderSession({ prefix, ttlMs, maxMappings, secret })` — `secret` обязателен, 32 байта, иначе `Error("PlaceholderSession needs a 32-byte secret")`;
  - `getOrCreatePlaceholder(original, category) -> string`;
  - `lookup(placeholder) -> string | undefined`;
  - `cleanup(now?)`;
  - `knownEntries() -> Iterable<[original, placeholder]>`;
  - `getPlaceholderRegex(prefix) -> RegExp` (без изменений).

- [ ] **Step 1: Написать падающий тест**

`test/unit/session.test.js`:
```js
import { test } from "node:test"
import assert from "node:assert/strict"
import { PlaceholderSession, getPlaceholderRegex } from "../../src/session.js"

const KEY_A = Buffer.alloc(32, 1)
const KEY_B = Buffer.alloc(32, 2)
const make = (secret = KEY_A, extra = {}) => new PlaceholderSession({ prefix: "__VG_", ttlMs: 60_000, maxMappings: 100, secret, ...extra })

test("same key gives the same placeholder in a fresh instance", () => {
  const first = make().getOrCreatePlaceholder("hunter2", "test")
  assert.equal(make().getOrCreatePlaceholder("hunter2", "test"), first)
  assert.match(first, /^__VG_TEST_[0-9a-f]{12}__$/)
})

test("another key gives another placeholder", () => {
  assert.notEqual(make(KEY_A).getOrCreatePlaceholder("hunter2", "x"), make(KEY_B).getOrCreatePlaceholder("hunter2", "x"))
})

test("a secret is required", () => {
  assert.throws(() => new PlaceholderSession({ prefix: "__VG_" }), /needs a 32-byte secret/)
  assert.throws(() => make(Buffer.alloc(8)), /needs a 32-byte secret/)
})

test("knownEntries lists original and placeholder", () => {
  const s = make()
  const ph = s.getOrCreatePlaceholder("hunter2", "test")
  assert.deepEqual([...s.knownEntries()], [["hunter2", ph]])
  assert.equal(s.lookup(ph), "hunter2")
})

test("expired mappings are dropped by cleanup", () => {
  const s = make(KEY_A, { ttlMs: 1000 })
  const ph = s.getOrCreatePlaceholder("hunter2", "test")
  s.cleanup(Date.now() + 5000)
  assert.equal(s.lookup(ph), undefined)
})

test("the oldest mapping is evicted at max_mappings", () => {
  const s = make(KEY_A, { maxMappings: 1 })
  const first = s.getOrCreatePlaceholder("one", "t")
  s.getOrCreatePlaceholder("two", "t")
  assert.equal(s.lookup(first), undefined)
})

test("placeholder regex finds suffixed placeholders", () => {
  assert.deepEqual("a __VG_X_0123456789ab__ b __VG_X_0123456789ab_2__".match(getPlaceholderRegex("__VG_")).length, 2)
})
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `node --test test/unit/session.test.js`
Expected: FAIL — `a secret is required` (upstream берёт случайный ключ) и `s.knownEntries is not a function`.

- [ ] **Step 3: Реализация**

В `src/session.js` заменить строку конструктора
```js
    this.secret = options?.secret ? Uint8Array.from(options.secret) : randomBytes(32)
```
на
```js
    // The key comes from key.js: a random per-process key would change every placeholder
    // after an OpenCode restart, while the stored replies still hold the old ones.
    if (!options?.secret || options.secret.length !== 32) throw new Error("PlaceholderSession needs a 32-byte secret")
    this.secret = Uint8Array.from(options.secret)
```
Импорт заменить на `import { createHmac } from "node:crypto"`. После `lookupReverse` добавить:
```js
  knownEntries() {
    return this.reverse.entries()
  }
```

- [ ] **Step 4: Запустить тесты**

Run: `npm test`
Expected: PASS, все тесты.

- [ ] **Step 5: Commit**

```bash
git add src/session.js test/unit/session.test.js
git commit -m "feat: key-backed placeholder mapping shared across sessions"
```

---

### Task 6: Встроенные правила для токенов и строгая проверка правил

**Files:**
- Modify: `src/patterns.js` (карта `BUILTIN`, `buildPatternSet`)
- Test: `test/unit/patterns.test.js`

**Interfaces:**
- Consumes: `redactText(text, patterns, session)` (upstream `engine.js`).
- Produces:
  - `buildPatternSet(patterns) -> { keywords, regex, exclude: Set }` — бросает `Error` на неизвестное правило, битый regex или неверный тип; текст ошибки не содержит значений `keywords`;
  - `BUILTIN_NAMES: string[]`.

- [ ] **Step 1: Написать падающий тест**

`test/unit/patterns.test.js`:
```js
import { test } from "node:test"
import assert from "node:assert/strict"
import { buildPatternSet, BUILTIN_NAMES } from "../../src/patterns.js"
import { redactText } from "../../src/engine.js"

function hits(text, builtin) {
  const found = []
  redactText(text, buildPatternSet({ builtin }), {
    getOrCreatePlaceholder(original, category) { found.push({ original, category }); return "X" },
  })
  return found
}

const SAMPLES = {
  openai_key: [`key sk-proj-${"Ab3".repeat(16)} end`, "OPENAI_KEY"],
  anthropic_key: [`sk-ant-api03-${"Xy9_".repeat(20)}`, "ANTHROPIC_KEY"],
  github_token: [`token=ghp_${"aB3d".repeat(9)}`, "GITHUB_TOKEN"],
  aws_access_key: ["id AKIAIOSFODNN7EXAMPLE x", "AWS_ACCESS_KEY"],
  google_api_key: [`AIza${"Sy0_-".repeat(7)}`, "GOOGLE_API_KEY"],
  private_key: ["-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----", "PRIVATE_KEY"],
  jwt: ["Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "JWT"],
}

for (const [name, [text, category]] of Object.entries(SAMPLES)) {
  test(`${name} catches its real format`, () => {
    const found = hits(text, [name])
    assert.equal(found.length, 1)
    assert.equal(found[0].category, category)
  })
}

test("private_key takes the whole block", () => {
  assert.equal(hits(SAMPLES.private_key[0], ["private_key"])[0].original, SAMPLES.private_key[0])
})

test("an Anthropic key is not reported as an OpenAI key", () => {
  assert.deepEqual(hits(SAMPLES.anthropic_key[0], ["openai_key"]), [])
})

test("lookalikes are left alone", () => {
  const all = Object.keys(SAMPLES)
  for (const text of ["task-runner-configuration-file-name", "sk-learn", "ghp_short", "AKIA1234", "AIzaShort",
    "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----", "eyJhbGciOi"]) {
    assert.deepEqual(hits(text, all), [], text)
  }
})

test("every new rule is a known builtin", () => {
  for (const name of [...Object.keys(SAMPLES), "email"]) assert.ok(BUILTIN_NAMES.includes(name), name)
})

test("an unknown builtin is an error", () => {
  assert.throws(() => buildPatternSet({ builtin: ["nope"] }), /unknown builtin rule "nope"/)
})

test("a broken regex is an error that names its category", () => {
  assert.throws(() => buildPatternSet({ regex: [{ pattern: "(", category: "mine" }] }), /patterns\.regex\[0\] \(MINE\) is not a valid regex/)
})

test("wrong shapes are errors and never echo keyword values", () => {
  assert.throws(() => buildPatternSet({ keywords: "x" }), /patterns\.keywords must be an array/)
  assert.throws(() => buildPatternSet([]), /patterns must be an object/)
  const error = (() => { try { buildPatternSet({ keywords: [{ value: 42 }] }) } catch (e) { return e } })()
  assert.match(error.message, /patterns\.keywords\[0\] needs a non-empty string "value"/)
  assert.doesNotMatch(error.message, /42/)
})
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `node --test test/unit/patterns.test.js`
Expected: FAIL — `BUILTIN_NAMES` не экспортирован; новые правила не находят ничего; неизвестное правило upstream молча пропускает.

- [ ] **Step 3: Реализация**

В `src/patterns.js` добавить в `new Map([...])` после `"mac"`:
```js
  ["openai_key", { pattern: String.raw`(?<![A-Za-z0-9_-])sk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}`, flags: "", category: "OPENAI_KEY" }],
  ["anthropic_key", { pattern: String.raw`(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}`, flags: "", category: "ANTHROPIC_KEY" }],
  ["github_token", { pattern: String.raw`(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})`, flags: "", category: "GITHUB_TOKEN" }],
  ["aws_access_key", { pattern: String.raw`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`, flags: "", category: "AWS_ACCESS_KEY" }],
  ["google_api_key", { pattern: String.raw`(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}`, flags: "", category: "GOOGLE_API_KEY" }],
  ["private_key", { pattern: String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----`, flags: "", category: "PRIVATE_KEY" }],
  ["jwt", { pattern: String.raw`(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`, flags: "", category: "JWT" }],
```
После карты добавить `export const BUILTIN_NAMES = [...BUILTIN.keys()]`. Функцию `buildPatternSet` заменить целиком:
```js
function fail(message) {
  throw new Error(message)
}

function listOf(raw, key) {
  const value = raw[key]
  if (value === undefined) return []
  if (!Array.isArray(value)) fail(`patterns.${key} must be an array`)
  return value
}

/**
 * Strict on purpose: a rule that silently drops out stops hiding its secret, so any
 * malformed rule is an error the caller turns into a blocked request.
 * Messages name positions and categories, never keyword values.
 */
export function buildPatternSet(patterns) {
  if (patterns !== undefined && (patterns === null || typeof patterns !== "object" || Array.isArray(patterns))) {
    fail("patterns must be an object")
  }
  const raw = patterns ?? {}

  const keywords = listOf(raw, "keywords").map((x, i) => {
    if (!x || typeof x !== "object" || typeof x.value !== "string" || !x.value.trim()) {
      fail(`patterns.keywords[${i}] needs a non-empty string "value"`)
    }
    return { value: x.value.trim(), category: sanitizeCategory(x.category) }
  })

  const regex = listOf(raw, "regex").map((x, i) => {
    if (!x || typeof x !== "object" || typeof x.pattern !== "string" || !x.pattern.trim()) {
      fail(`patterns.regex[${i}] needs a non-empty string "pattern"`)
    }
    const category = sanitizeCategory(x.category)
    const peeled = peelInlineFlags(x.pattern.trim(), typeof x.flags === "string" ? x.flags : "")
    try {
      new RegExp(peeled.pattern, peeled.flags.includes("g") ? peeled.flags : `${peeled.flags}g`)
    } catch (error) {
      fail(`patterns.regex[${i}] (${category}) is not a valid regex: ${error.message}`)
    }
    return { pattern: peeled.pattern, flags: peeled.flags, category }
  })

  for (const name of listOf(raw, "builtin")) {
    const rule = BUILTIN.get(String(name).trim())
    if (!rule) fail(`unknown builtin rule "${name}"; known: ${BUILTIN_NAMES.join(", ")}`)
    regex.push({ pattern: rule.pattern, flags: rule.flags, category: rule.category })
  }

  const exclude = new Set(listOf(raw, "exclude").map((x) => String(x ?? "")))
  return { keywords, regex, exclude }
}
```

- [ ] **Step 4: Запустить тесты**

Run: `npm test`
Expected: PASS, все тесты.

- [ ] **Step 5: Commit**

```bash
git add src/patterns.js test/unit/patterns.test.js
git commit -m "feat: token, private key and JWT rules; strict rule validation"
```

---

### Task 7: Строгий конфиг и `key_file`

**Files:**
- Modify: `src/config.js` (переписать целиком)
- Test: `test/unit/config.test.js`

**Interfaces:**
- Consumes: `defaultKeyFile()` (Задача 4).
- Produces:
  - `loadConfig(directory) -> Promise<{ enabled, debug, prefix, ttlMs, maxMappings, patterns, keyFile, loadedFrom }>` — бросает `Error` на битый конфиг;
  - `getConfigCandidates(directory) -> string[]`.

- [ ] **Step 1: Написать падающий тест**

`test/unit/config.test.js`:
```js
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { loadConfig } from "../../src/config.js"
import { tmpdir, withHome } from "../helpers/tmp.js"

function setup(t) {
  const home = tmpdir(t)
  const project = tmpdir(t)
  withHome(t, home)
  const prev = process.env.OPENCODE_VIBEGUARD_CONFIG
  delete process.env.OPENCODE_VIBEGUARD_CONFIG
  t.after(() => { if (prev !== undefined) process.env.OPENCODE_VIBEGUARD_CONFIG = prev })
  const write = (file, value) => {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value))
    return file
  }
  return { home, project, write, global: path.join(home, ".config", "opencode", "vibeguard.config.json") }
}

test("no config anywhere means disabled", async (t) => {
  const { project } = setup(t)
  const cfg = await loadConfig(project)
  assert.equal(cfg.enabled, false)
  assert.equal(cfg.loadedFrom, "")
})

test("project root wins over .opencode and global", async (t) => {
  const { project, write, global } = setup(t)
  write(global, { enabled: true, debug: false })
  write(path.join(project, ".opencode", "vibeguard.config.json"), { enabled: true, debug: false })
  const root = write(path.join(project, "vibeguard.config.json"), { enabled: true, debug: true })
  const cfg = await loadConfig(project)
  assert.equal(cfg.loadedFrom, root)
  assert.equal(cfg.debug, true)
})

test("env path wins over everything", async (t) => {
  const { project, write } = setup(t)
  write(path.join(project, "vibeguard.config.json"), { enabled: false })
  const env = write(path.join(project, "custom.json"), { enabled: true })
  process.env.OPENCODE_VIBEGUARD_CONFIG = env
  assert.equal((await loadConfig(project)).loadedFrom, env)
})

test("defaults: 24h ttl, default key, __VG_ prefix", async (t) => {
  const { home, project, write, global } = setup(t)
  write(global, { enabled: true })
  const cfg = await loadConfig(project)
  assert.equal(cfg.ttlMs, 24 * 60 * 60 * 1000)
  assert.equal(cfg.prefix, "__VG_")
  assert.equal(cfg.keyFile, path.join(home, ".config", "opencode", "vibeguard.key"))
})

test("key_file is resolved next to its config and expands ~", async (t) => {
  const { home, project, write } = setup(t)
  write(path.join(project, "vibeguard.config.json"), { enabled: true, key_file: "keys/k" })
  assert.equal((await loadConfig(project)).keyFile, path.join(project, "keys", "k"))
  write(path.join(project, "vibeguard.config.json"), { enabled: true, key_file: "~/k" })
  assert.equal((await loadConfig(project)).keyFile, path.join(home, "k"))
})

test("broken JSON is an error that does not echo the file", async (t) => {
  const { project, write } = setup(t)
  write(path.join(project, "vibeguard.config.json"), '{ "patterns": { "keywords": [{ "value": "hunter2" ')
  await assert.rejects(loadConfig(project), (error) => {
    assert.match(error.message, /is not valid JSON/)
    assert.doesNotMatch(error.message, /hunter2/)
    return true
  })
})

test("bad field types and durations are errors", async (t) => {
  const { project, write } = setup(t)
  const file = path.join(project, "vibeguard.config.json")
  write(file, { enabled: "yes" })
  await assert.rejects(loadConfig(project), /"enabled" must be a boolean/)
  write(file, { enabled: true, session: { ttl: "forever" } })
  await assert.rejects(loadConfig(project), /session\.ttl/)
  write(file, { enabled: true, session: { max_mappings: 0 } })
  await assert.rejects(loadConfig(project), /session\.max_mappings/)
  write(file, { enabled: true, placeholder_prefix: "bad prefix" })
  await assert.rejects(loadConfig(project), /placeholder_prefix/)
  write(file, { enabled: true, key_file: 7 })
  await assert.rejects(loadConfig(project), /key_file/)
})
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `node --test test/unit/config.test.js`
Expected: FAIL — нет `keyFile`, TTL по умолчанию 1h, битый JSON молча пропускается.

- [ ] **Step 3: Реализация**

`src/config.js` целиком:
```js
import { existsSync } from "node:fs"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { defaultKeyFile } from "./key.js"

const UNITS = { ms: 1, s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 }

function fail(file, message) {
  throw new Error(`config ${file}: ${message}`)
}

function parseDurationMs(input, file) {
  const m = String(input).trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/)
  if (!m) fail(file, `session.ttl "${input}" must look like 30m, 24h or 7d`)
  return Number(m[1]) * UNITS[m[2]]
}

function expandHome(p) {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p
}

async function readJson(file) {
  const text = await fs.readFile(file, "utf8")
  try {
    return JSON.parse(text)
  } catch {
    // JSON.parse messages quote the text around the error, and that text can be a secret.
    fail(file, "is not valid JSON")
  }
}

/**
 * Strict on purpose: a config that half-loads protects less than the user believes,
 * so every malformed field is an error and the plugin blocks requests instead.
 */
function normalizeConfig(raw, file) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(file, "must be a JSON object")
  for (const key of ["enabled", "debug"]) {
    if (raw[key] !== undefined && typeof raw[key] !== "boolean") fail(file, `"${key}" must be a boolean`)
  }
  const prefix = raw.placeholder_prefix ?? "__VG_"
  if (typeof prefix !== "string" || !/^[A-Za-z0-9_]+$/.test(prefix)) fail(file, "placeholder_prefix must match [A-Za-z0-9_]+")

  const session = raw.session ?? {}
  if (typeof session !== "object" || Array.isArray(session)) fail(file, "session must be an object")
  const ttlMs = parseDurationMs(session.ttl ?? "24h", file)
  const maxMappings = session.max_mappings ?? 100000
  if (!Number.isInteger(maxMappings) || maxMappings <= 0) fail(file, "session.max_mappings must be a positive integer")

  if (raw.key_file !== undefined && (typeof raw.key_file !== "string" || !raw.key_file)) fail(file, "key_file must be a non-empty string")
  const keyFile = raw.key_file ? path.resolve(path.dirname(file), expandHome(raw.key_file)) : defaultKeyFile()

  return {
    enabled: raw.enabled === true,
    debug: raw.debug === true,
    prefix,
    ttlMs,
    maxMappings,
    patterns: raw.patterns,
    keyFile,
  }
}

export function getConfigCandidates(directory) {
  const dir = String(directory ?? process.cwd())
  const candidates = [
    path.join(dir, "vibeguard.config.json"),
    path.join(dir, ".opencode", "vibeguard.config.json"),
    path.join(os.homedir(), ".config", "opencode", "vibeguard.config.json"),
  ]
  const env = process.env.OPENCODE_VIBEGUARD_CONFIG
  return env ? [path.resolve(dir, expandHome(env)), ...candidates] : candidates
}

/** First existing candidate wins. None at all: disabled, a deliberate off switch. */
export async function loadConfig(directory) {
  for (const file of getConfigCandidates(directory)) {
    if (!existsSync(file)) continue
    return { ...normalizeConfig(await readJson(file), file), loadedFrom: file }
  }
  return {
    enabled: false, debug: false, prefix: "__VG_", ttlMs: UNITS.d, maxMappings: 100000,
    patterns: undefined, keyFile: defaultKeyFile(), loadedFrom: "",
  }
}
```

- [ ] **Step 4: Запустить тесты**

Run: `npm test`
Expected: PASS, все тесты.

- [ ] **Step 5: Commit**

```bash
git add src/config.js test/unit/config.test.js
git commit -m "feat: strict config with key_file and 24h default ttl"
```

---

### Task 8: Обход структур V2

**Files:**
- Create: `src/messages.js`
- Test: `test/unit/messages.test.js`

**Interfaces:**
- Consumes:
  - `redactText` (`engine.js`);
  - `restoreText` (`restore.js`);
  - `PlaceholderSession` (Задача 5);
  - `buildPatternSet` (Задача 6);
  - формы F4 из `docs/v2-facts.md` (Задача 3).
- Produces:
  - `SKIP_KEYS: Set<string>`;
  - `mapStrings(root, fn, skip = new Set()) -> number` (меняет на месте, возвращает число изменённых строк);
  - `redactStrings(root, patterns, session) -> number`;
  - `restoreStrings(root, session) -> number`.

- [ ] **Step 1: Сверить формы с фактами**

Прочитать F4 в `docs/v2-facts.md`. Тест ниже использует формы, наблюдавшиеся в спайке: `{ id, role, content: [{ type, text }] }` и `system: [{ type: "text", text }]`. Части инструментов в нём — гипотеза. Если в F4 записаны другие ключи для вызова и результата инструмента или рассуждения, `toolPart()` и `reasoningPart()` в тесте переписать по F4 (Ruling). Код обхода от этого не зависит: он обходит все ключи.

- [ ] **Step 2: Написать падающий тест**

`test/unit/messages.test.js`:
```js
import { test } from "node:test"
import assert from "node:assert/strict"
import { mapStrings, redactStrings, restoreStrings, SKIP_KEYS } from "../../src/messages.js"
import { buildPatternSet } from "../../src/patterns.js"
import { PlaceholderSession } from "../../src/session.js"

const SECRET = "hunter2-very-secret"
const patterns = buildPatternSet({ keywords: [{ value: SECRET, category: "test" }] })
const session = () => new PlaceholderSession({ prefix: "__VG_", ttlMs: 60_000, maxMappings: 100, secret: Buffer.alloc(32, 7) })
const toolPart = (input, output) => ({ type: "tool", id: "p1", tool: "shell", callID: "c1", state: { status: "completed", input, output } })
const reasoningPart = (text) => ({ type: "reasoning", id: "p2", text })

test("system, text, reasoning and tool input/output are all redacted", () => {
  const s = session()
  const system = [{ type: "text", text: `password ${SECRET}` }]
  const messages = [
    { id: "m1", role: "user", content: [{ type: "text", text: `use ${SECRET}` }] },
    { id: "m2", role: "assistant", content: [reasoningPart(`thinking about ${SECRET}`), toolPart({ command: `echo ${SECRET}` }, `${SECRET}\n`)] },
  ]
  const changed = redactStrings(system, patterns, s) + redactStrings(messages, patterns, s)
  assert.equal(changed, 5)
  assert.ok(!JSON.stringify({ system, messages }).includes(SECRET))
})

test("service fields are never rewritten", () => {
  const s = session()
  const part = { type: "text", id: SECRET, callID: SECRET, text: SECRET }
  redactStrings([part], patterns, s)
  assert.equal(part.id, SECRET)
  assert.equal(part.callID, SECRET)
  assert.notEqual(part.text, SECRET)
  assert.ok(SKIP_KEYS.has("callID"))
})

test("test_class_instances_are_walked", () => {
  class TextPart { constructor(text) { this.type = "text"; this.text = text } }
  const msgs = [{ role: "user", content: [new TextPart(`x ${SECRET}`)] }]
  redactStrings(msgs, patterns, session())
  assert.ok(!msgs[0].content[0].text.includes(SECRET))
})

test("redaction is idempotent", () => {
  const s = session()
  const msgs = [{ content: [{ type: "text", text: `a ${SECRET} b` }] }]
  redactStrings(msgs, patterns, s)
  const once = JSON.stringify(msgs)
  assert.equal(redactStrings(msgs, patterns, s), 0)
  assert.equal(JSON.stringify(msgs), once)
})

test("restore brings the value back and leaves unknown placeholders", () => {
  const s = session()
  const msgs = [{ content: [{ type: "text", text: SECRET }] }]
  redactStrings(msgs, patterns, s)
  const input = { command: `echo ${msgs[0].content[0].text} __VG_TEST_0123456789ab__` }
  restoreStrings(input, s)
  assert.equal(input.command, `echo ${SECRET} __VG_TEST_0123456789ab__`)
})

test("cycles and binary values are survived", () => {
  const node = { text: SECRET, bytes: new Uint8Array([1, 2]) }
  node.self = node
  assert.equal(mapStrings(node, (x) => x.toUpperCase()), 1)
  assert.equal(node.text, SECRET.toUpperCase())
})
```

- [ ] **Step 3: Запустить и убедиться, что падает**

Run: `node --test test/unit/messages.test.js`
Expected: FAIL — `Cannot find module '…/src/messages.js'`.

- [ ] **Step 4: Реализация**

`src/messages.js`:
```js
import { redactText } from "./engine.js"
import { restoreText } from "./restore.js"

/**
 * String fields that identify things rather than carry content. Rewriting them would break
 * tool-call pairing or message routing. Objects under these keys are still walked.
 */
export const SKIP_KEYS = new Set([
  "id", "type", "role", "sessionID", "messageID", "callID", "toolCallId", "toolCallID",
  "toolName", "tool", "providerID", "modelID", "mime", "mediaType",
])

const NO_SKIP = new Set()

function walkable(value) {
  return value !== null && typeof value === "object" && !ArrayBuffer.isView(value) && !(value instanceof Date) && !(value instanceof RegExp)
}

/**
 * Applies fn to every string reachable from root, in place. Any object is walked, not only
 * plain ones: V2 may hand over class instances, and skipping them would leak their text.
 */
export function mapStrings(root, fn, skip = NO_SKIP) {
  let changed = 0
  const seen = new WeakSet()
  const visit = (node) => {
    if (!walkable(node) || seen.has(node)) return
    seen.add(node)
    const isArray = Array.isArray(node)
    for (const key of isArray ? node.keys() : Object.keys(node)) {
      const value = node[key]
      if (typeof value !== "string") {
        visit(value)
        continue
      }
      if (!isArray && skip.has(key)) continue
      const next = fn(value)
      if (next !== value) {
        node[key] = next
        changed++
      }
    }
  }
  visit(root)
  return changed
}

export function redactStrings(root, patterns, session) {
  return mapStrings(root, (text) => redactText(text, patterns, session).text, SKIP_KEYS)
}

export function restoreStrings(root, session) {
  return mapStrings(root, (text) => restoreText(text, session))
}
```

- [ ] **Step 5: Запустить тесты**

Run: `npm test`
Expected: PASS, все тесты.

- [ ] **Step 6: Commit**

```bash
git add src/messages.js test/unit/messages.test.js
git commit -m "feat: walk V2 system/messages for redaction and restore"
```

---

### Task 9: Страж исходящих тел

**Files:**
- Create: `src/guard.js`
- Test: `test/unit/guard.test.js`

**Interfaces:**
- Consumes:
  - `mapStrings` (Задача 8);
  - `redactText` (`engine.js`);
  - `getPlaceholderRegex`, `knownEntries` (Задача 5);
  - `buildPatternSet` (Задача 6).
- Produces: `findLeak(bodyText, patterns, session) -> null | { category: string }` (никогда не возвращает значение).

- [ ] **Step 1: Написать падающий тест**

`test/unit/guard.test.js`:
```js
import { test } from "node:test"
import assert from "node:assert/strict"
import { findLeak } from "../../src/guard.js"
import { buildPatternSet } from "../../src/patterns.js"
import { PlaceholderSession } from "../../src/session.js"

const patterns = buildPatternSet({ builtin: ["email", "private_key"], exclude: ["noreply@anthropic.com"] })
const session = () => new PlaceholderSession({ prefix: "__VG_", ttlMs: 60_000, maxMappings: 100, secret: Buffer.alloc(32, 3) })
const body = (content) => JSON.stringify({ model: "m", messages: [{ role: "user", content }] })

test("a clean body passes", () => {
  assert.equal(findLeak(body("hello"), patterns, session()), null)
})

test("a rule match is reported by category only", () => {
  const leak = findLeak(body("mail me at alice@corp.io"), patterns, session())
  assert.deepEqual(leak, { category: "EMAIL" })
})

test("escaped secret is caught", () => {
  const s = session()
  const original = 'pa"ss\nword-42'
  const ph = s.getOrCreatePlaceholder(original, "test")
  assert.ok(ph)
  assert.deepEqual(findLeak(body(`x ${original} y`), patterns, s), { category: "TEST" })
  const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----"
  assert.deepEqual(findLeak(body(key), patterns, s), { category: "PRIVATE_KEY" })
})

test("placeholders and excluded values pass", () => {
  const s = session()
  const ph = s.getOrCreatePlaceholder("alice@corp.io", "email")
  assert.equal(findLeak(body(`send to ${ph} from noreply@anthropic.com`), patterns, s), null)
})

test("a non-JSON body is scanned as text", () => {
  assert.deepEqual(findLeak("raw alice@corp.io", patterns, session()), { category: "EMAIL" })
  assert.equal(findLeak("", patterns, session()), null)
})
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `node --test test/unit/guard.test.js`
Expected: FAIL — `Cannot find module '…/src/guard.js'`.

- [ ] **Step 3: Реализация**

`src/guard.js`:
```js
import { redactText } from "./engine.js"
import { mapStrings } from "./messages.js"
import { getPlaceholderRegex } from "./session.js"

function stringsOf(bodyText) {
  let parsed
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return [bodyText]
  }
  if (typeof parsed === "string") return [parsed]
  const out = []
  // Decoded strings, not the raw body: a secret with a quote or a newline is escaped in JSON
  // and would slip past a substring search of the wire text.
  mapStrings(parsed, (text) => {
    out.push(text)
    return text
  })
  return out
}

function categoryOf(placeholder, prefix) {
  return placeholder.slice(prefix.length).replace(/_[0-9a-fA-F]{12}(?:_\d+)?__$/, "")
}

/**
 * Last line of defence before bytes leave the machine: anything the rules match, or any value
 * already known to be secret, in any string of the outgoing body. Reports the category only.
 */
export function findLeak(bodyText, patterns, session) {
  if (!bodyText) return null
  const placeholders = getPlaceholderRegex(session.prefix)
  const known = [...session.knownEntries()]
  for (const raw of stringsOf(bodyText)) {
    const text = raw.replace(placeholders, " ")
    for (const [original, placeholder] of known) {
      if (text.includes(original)) return { category: categoryOf(placeholder, session.prefix) }
    }
    let category = null
    redactText(text, patterns, {
      getOrCreatePlaceholder(_original, ruleCategory) {
        category ??= ruleCategory
        return ""
      },
    })
    if (category) return { category }
  }
  return null
}
```

- [ ] **Step 4: Запустить тесты**

Run: `npm test`
Expected: PASS, все тесты.

- [ ] **Step 5: Commit**

```bash
git add src/guard.js test/unit/guard.test.js
git commit -m "feat: outgoing request guard"
```

---

### Task 10: Точка входа V2

**Files:**
- Modify: `src/index.js` (переписать целиком)
- Test: `test/unit/index.test.js`

**Interfaces:**
- Consumes:
  - `loadConfig` (Задача 7);
  - `buildPatternSet` (Задача 6);
  - `PlaceholderSession` (Задача 5);
  - `loadKey` (Задача 4);
  - `redactStrings`, `restoreStrings` (Задача 8);
  - `findLeak` (Задача 9);
  - `restoreText` (upstream).
- Produces:
  - `default { id: "vibeguard", setup }`;
  - `setup(ctx) -> Promise<void>`;
  - `REQUEST_HOOKS = ["context", "title", "compaction", "generate"]`;
  - `NO_RESTORE_TOOLS = Set(["websearch"])`.

- [ ] **Step 1: Написать падающий тест**

`test/unit/index.test.js`:
```js
import { test } from "node:test"
import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import path from "node:path"
import plugin, { REQUEST_HOOKS } from "../../src/index.js"
import { tmpdir, withHome } from "../helpers/tmp.js"

const SECRET = "vg-unit-Secret-91"

function fakeCtx(directory) {
  const hooks = { session: {}, tool: {} }
  const reg = (bucket) => async (name, cb) => { hooks[bucket][name] = cb; return { dispose() {} } }
  return { hooks, ctx: { location: { directory }, session: { hook: reg("session") }, tool: { hook: reg("tool") } } }
}

async function start(t, config) {
  const home = tmpdir(t)
  const project = tmpdir(t)
  withHome(t, home)
  if (config !== undefined) {
    const body = typeof config === "string" ? config : JSON.stringify({ key_file: path.join(home, "k"), ...config })
    writeFileSync(path.join(project, "vibeguard.config.json"), body)
  }
  const { hooks, ctx } = fakeCtx(project)
  await plugin.setup(ctx)
  return hooks
}

const ON = { enabled: true, patterns: { keywords: [{ value: SECRET, category: "test" }] } }
const event = (text) => ({ sessionID: "s1", system: [{ type: "text", text: `sys ${text}` }], messages: [{ role: "user", content: [{ type: "text", text }] }] })

test("plugin shape is V2", () => {
  assert.equal(plugin.id, "vibeguard")
  assert.equal(typeof plugin.setup, "function")
})

test("no config registers nothing", async (t) => {
  const hooks = await start(t)
  assert.deepEqual(hooks, { session: {}, tool: {} })
})

test("all request hooks, the guard and execute.before are registered", async (t) => {
  const hooks = await start(t, ON)
  assert.deepEqual(Object.keys(hooks.session).sort(), [...REQUEST_HOOKS, "http.request"].sort())
  assert.deepEqual(Object.keys(hooks.tool), ["execute.before"])
})

test("context and title hide the secret in system and messages", async (t) => {
  const hooks = await start(t, ON)
  for (const name of ["context", "title"]) {
    const e = event(`token ${SECRET}`)
    await hooks.session[name](e)
    assert.ok(!JSON.stringify(e).includes(SECRET), name)
    assert.match(e.messages[0].content[0].text, /__VG_TEST_[0-9a-f]{12}__/)
  }
})

test("execute.before restores across sessions, except websearch", async (t) => {
  const hooks = await start(t, ON)
  const e = event(SECRET)
  await hooks.session.context(e)
  const ph = e.messages[0].content[0].text
  const shell = { tool: "shell", sessionID: "other-session", input: { command: `echo ${ph}` } }
  await hooks.tool["execute.before"](shell)
  assert.equal(shell.input.command, `echo ${SECRET}`)
  const search = { tool: "websearch", sessionID: "s1", input: { query: ph } }
  await hooks.tool["execute.before"](search)
  assert.equal(search.input.query, ph)
})

test("unknown placeholder is left alone", async (t) => {
  const hooks = await start(t, ON)
  const e = { tool: "shell", input: { command: "echo __VG_TEST_0123456789ab__" } }
  await hooks.tool["execute.before"](e)
  assert.equal(e.input.command, "echo __VG_TEST_0123456789ab__")
})

test("the guard rejects plaintext and passes clean bodies", async (t) => {
  const hooks = await start(t, ON)
  const req = (content) => ({ kind: "primary", request: new Request("http://x/v1/chat/completions", { method: "POST", body: JSON.stringify({ messages: [{ content }] }) }) })
  await hooks.session["http.request"](req("all clean"))
  await assert.rejects(hooks.session["http.request"](req(`leak ${SECRET}`)), (error) => {
    assert.match(error.message, /vibeguard: plaintext TEST in outgoing primary request/)
    assert.ok(!error.message.includes(SECRET))
    return true
  })
})

test("a broken config blocks everything and empties the request", async (t) => {
  const hooks = await start(t, '{ "enabled": true, "patterns": { "regex": [{ "pattern": "(" }] } }')
  const e = event(`token ${SECRET}`)
  await assert.rejects(hooks.session.context(e), /vibeguard: /)
  assert.deepEqual(e.system, [])
  assert.deepEqual(e.messages, [])
  await assert.rejects(hooks.session["http.request"]({ kind: "title", request: new Request("http://x", { method: "POST", body: "{}" }) }), /vibeguard: /)
  await assert.rejects(hooks.tool["execute.before"]({ tool: "shell", input: { command: "ls" } }), /vibeguard: /)
})

test("broken JSON config also blocks, without echoing the file", async (t) => {
  const hooks = await start(t, `{ "patterns": { "keywords": [{ "value": "${SECRET}" `)
  await assert.rejects(hooks.session.context(event("x")), (error) => !error.message.includes(SECRET))
})
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `node --test test/unit/index.test.js`
Expected: FAIL — upstream `index.js` экспортирует `VibeGuardPrivacy`, `plugin.setup` не функция.

- [ ] **Step 3: Реализация**

`src/index.js` целиком:
```js
import { loadConfig } from "./config.js"
import { findLeak } from "./guard.js"
import { loadKey } from "./key.js"
import { redactStrings, restoreStrings } from "./messages.js"
import { buildPatternSet } from "./patterns.js"
import { restoreText } from "./restore.js"
import { PlaceholderSession } from "./session.js"

const LOG = "[vibeguard]"

/** Session hooks that see an LLM request before it is sent: system and messages are redacted here. */
export const REQUEST_HOOKS = ["context", "title", "compaction", "generate"]

/** A secret never belongs in a query to a third-party search service. */
export const NO_RESTORE_TOOLS = new Set(["websearch"])

async function bodyText(request) {
  if (!request) return ""
  if (typeof request.clone === "function") return request.clone().text()
  return typeof request.body === "string" ? request.body : ""
}

/** If OpenCode ever sends a request whose hook failed, it goes out empty. */
function block(event) {
  for (const key of ["system", "messages"]) {
    if (Array.isArray(event?.[key])) event[key].length = 0
  }
}

async function setup(ctx) {
  let state
  try {
    const config = await loadConfig(ctx?.location?.directory)
    if (!config.enabled) {
      if (config.debug) console.error(`${LOG} disabled (${config.loadedFrom || "no config"})`)
      return
    }
    state = {
      config,
      patterns: buildPatternSet(config.patterns),
      session: new PlaceholderSession({
        prefix: config.prefix, ttlMs: config.ttlMs, maxMappings: config.maxMappings, secret: loadKey(config.keyFile),
      }),
    }
  } catch (error) {
    // Fail closed: a guard that cannot start must not let requests through unguarded.
    state = { error }
    console.error(`${LOG} setup failed, every request is blocked: ${error.message}`)
  }

  const ready = () => {
    if (state.error) throw new Error(`vibeguard: ${state.error.message}`)
  }
  const debug = (line) => {
    if (state.config?.debug) console.error(`${LOG} ${line}`)
  }

  for (const name of REQUEST_HOOKS) {
    await ctx.session.hook(name, async (event) => {
      try {
        ready()
        state.session.cleanup()
        const replaced = redactStrings(event.system, state.patterns, state.session) + redactStrings(event.messages, state.patterns, state.session)
        debug(`kind=${name} replaced=${replaced}`)
      } catch (error) {
        block(event)
        console.error(`${LOG} ${name} request blocked: ${error.message}`)
        throw error
      }
    })
  }

  await ctx.session.hook("http.request", async (event) => {
    ready()
    const leak = findLeak(await bodyText(event.request), state.patterns, state.session)
    debug(`kind=${event.kind} guard=${leak ? "BLOCKED" : "clean"}`)
    if (leak) throw new Error(`vibeguard: plaintext ${leak.category} in outgoing ${event.kind} request`)
  })

  await ctx.tool.hook("execute.before", async (event) => {
    ready()
    if (NO_RESTORE_TOOLS.has(event.tool)) return
    if (typeof event.input === "string") event.input = restoreText(event.input, state.session)
    else restoreStrings(event.input, state.session)
  })
}

export { setup }
export default { id: "vibeguard", setup }
```

- [ ] **Step 4: Запустить тесты**

Run: `npm test`
Expected: PASS, все тесты.

- [ ] **Step 5: Commit**

```bash
git add src/index.js test/unit/index.test.js
git commit -m "feat: V2 entry point with fail-closed hooks"
```

---

### Task 11: E2E — утечки, восстановление в shell, fail-closed

**Files:**
- Create: `test/e2e/redaction.test.js`

**Interfaces:**
- Consumes:
  - `startMockProvider`, `toolNames`, `toolArgs`, `PLACEHOLDER` (Задача 2);
  - `makeProject`, `runOpencode` (Задача 3);
  - F2, F3, F9, F11 из `docs/v2-facts.md`;
  - готовый плагин (Задача 10).
- Produces: `npm run test:e2e` — сценарии 1, 2, 6 спеки §6.2.

- [ ] **Step 1: Написать e2e-тест**

`test/e2e/redaction.test.js`:
```js
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
  assert.match(run.stdout + run.stderr, /vibeguard/)
})
```
Если по F11 модель видит shell-инструмент под другим именем, расширить `shellName` (Ruling). Утечку провайдеру во втором тесте проверяет `mock.requests.length === 0`; печать собственного промпта пользователю на экран — не утечка.

- [ ] **Step 2: Запустить e2e**

Run: `npm run test:e2e`
Expected: PASS — smoke и 2 сценария. При провале — superpowers:systematic-debugging. Тело провального запроса лежит в `mock.requests[i].raw`; печатать его в выводе нельзя, нужно смотреть, какой ключ JSON содержит секрет, через `Object.keys` и пути. Исправлять код, а не тест.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/redaction.test.js
git commit -m "test(e2e): no plaintext to provider, shell restore, fail-closed"
```

---

### Task 12: E2E — субагент, compaction, перезапуск

**Files:**
- Create: `test/e2e/sessions.test.js`

**Interfaces:**
- Consumes:
  - то же, что Задача 11;
  - F5 (инструмент субагента и аргументы), F6 (вызов и признак compaction), F7 (формат id сессии) из `docs/v2-facts.md`.
- Produces: сценарии 3, 4, 5 спеки §6.2. Сценарий 7 (`websearch`) проверяется на юнит-уровне (Задача 10): настоящий `websearch` отправил бы запрос во внешнюю службу. Это нужно записать в ledger как Ruling.

- [ ] **Step 1: Подставить факты**

Из `docs/v2-facts.md` взять:
- `TASK_TOOL` и обязательные аргументы (F5);
- `SUBAGENT` (значение `subagent_type`);
- `COMPACTION_MARKER` — подстроку, по которой тело compaction отличается от обычного (F6);
- `sessionId()` (F7).

Ниже значения по умолчанию; их нужно заменить фактами, а замену записать как Ruling.

- [ ] **Step 2: Написать e2e-тест**

`test/e2e/sessions.test.js`:
```js
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { PLACEHOLDER, startMockProvider, toolArgs, toolNames } from "../helpers/mock-provider.js"
import { makeProject, runOpencode } from "../helpers/opencode.js"

const TASK_TOOL = "task"
const SUBAGENT = "general"
const COMPACTION_MARKER = /summar/i
const sessionId = () => `ses_vge2e${Date.now()}`

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
      return { tool: { name: TASK_TOOL, args: toolArgs(body, TASK_TOOL, { description: "write", prompt: `Write ${ph} to sub.txt`, subagent_type: SUBAGENT }) } }
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
  const mock = await startMockProvider(() => ({ text: "noted", usage: { prompt_tokens: 2900, completion_tokens: 50, total_tokens: 2950 } }))
  t.after(() => mock.close())
  const base = makeProject(t, { baseURL: mock.baseURL, plugin: false })
  const project = makeProject(t, { baseURL: mock.baseURL, vibeguard: config(base.home), contextLimit: 3000 })
  const session = sessionId()
  assert.equal((await runOpencode(project, `Remember ${SECRET}.`, { session })).code, 0)
  const second = await runOpencode(project, "And now?", { session })
  assert.equal(second.code, 0, second.stderr.slice(-3000))
  assert.ok(mock.requests.some((r) => COMPACTION_MARKER.test(r.raw)), "no compaction request seen")
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
```

- [ ] **Step 3: Запустить e2e**

Run: `npm run test:e2e`
Expected: PASS — все e2e. Если compaction не удаётся вызвать никаким способом из F6, не ослаблять тест молча: остановиться и сообщить. Это критерий спеки §8.2.

- [ ] **Step 4: Commit**

```bash
git add test/e2e/sessions.test.js
git commit -m "test(e2e): subagent restore, compaction, restart stability"
```

---

### Task 13: README, пример конфига, CI, публикация

**Files:**
- Modify: `README.md` (переписать)
- Delete: `README-zh.md`
- Modify: `vibeguard.config.json.example`
- Create: `.github/workflows/test.yml`
- Test: `test/unit/docs.test.js`

**Interfaces:**
- Consumes: всё выше.
- Produces: ветка `v2-port` в `origin`, зелёный CI, `main` = V2.

- [ ] **Step 1: Написать падающий тест**

`test/unit/docs.test.js`:
```js
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { buildPatternSet } from "../../src/patterns.js"

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8")

test("the example config is valid and uses the token rules", () => {
  const cfg = JSON.parse(read("vibeguard.config.json.example"))
  assert.equal(cfg.enabled, true)
  assert.doesNotThrow(() => buildPatternSet(cfg.patterns))
  for (const rule of ["openai_key", "anthropic_key", "github_token", "aws_access_key", "google_api_key", "private_key", "jwt", "email"]) {
    assert.ok(cfg.patterns.builtin.includes(rule), rule)
  }
})

test("README documents the V2 install line", () => {
  assert.match(read("README.md"), /opencode-vibeguard@git\+https:\/\/github\.com\/BohdanParkhomenkoNix\/opencode-vibeguard\.git/)
  assert.equal(existsSync(new URL("../../README-zh.md", import.meta.url)), false)
})

test("CI runs the unit tests", () => {
  assert.match(read(".github/workflows/test.yml"), /npm test/)
})
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `node --test test/unit/docs.test.js`
Expected: FAIL — в примере нет новых правил, README про V1, workflow нет.

- [ ] **Step 3: Файлы**

`vibeguard.config.json.example` — в точности конфиг из спеки §5:
```json
{
  "enabled": true,
  "debug": false,
  "placeholder_prefix": "__VG_",
  "session": { "ttl": "24h", "max_mappings": 100000 },
  "patterns": {
    "keywords": [],
    "regex": [],
    "builtin": ["openai_key", "anthropic_key", "github_token", "aws_access_key", "google_api_key", "private_key", "jwt", "email"],
    "exclude": ["example.com", "localhost", "127.0.0.1", "0.0.0.0", "noreply@anthropic.com"]
  }
}
```
`.github/workflows/test.yml`:
```yaml
name: test
on:
  push:
  pull_request:
jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm test
```
`README.md` целиком:
````markdown
# opencode-vibeguard (OpenCode V2)

Fork of [inkdust2021/opencode-vibeguard](https://github.com/inkdust2021/opencode-vibeguard) ported to the OpenCode V2 plugin API. V1 is not supported; use upstream for V1.

What it does:

- Before every LLM request (main loop, title, compaction, generate) it replaces secrets in the system prompt, messages and historical tool input/output with placeholders like `__VG_GITHUB_TOKEN_1a2b3c4d5e6f__`. The provider never sees the plaintext.
- A guard inspects every outgoing request body and blocks it if any rule still matches or a known secret is still there.
- Before a tool runs, placeholders in its arguments are replaced with the real values, so `bash`, `write`, `edit` and MCP tools work with real data. `websearch` keeps the placeholder.
- Fail-closed: a broken config, an unreadable key or an internal error blocks the request instead of sending it.

## Install

`~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugins": ["opencode-vibeguard@git+https://github.com/BohdanParkhomenkoNix/opencode-vibeguard.git"]
}
```

Update with `opencode plugin update`.

## Configure

Copy `vibeguard.config.json.example` to `~/.config/opencode/vibeguard.config.json` and add your own strings under `patterns.keywords` (`{ "value": "...", "category": "NAME" }`) or regexes under `patterns.regex`.

Lookup order, first match wins: `$OPENCODE_VIBEGUARD_CONFIG`, `<project>/vibeguard.config.json`, `<project>/.opencode/vibeguard.config.json`, `~/.config/opencode/vibeguard.config.json`. No config at all disables the plugin.

Built-in rules: `openai_key`, `anthropic_key`, `github_token`, `aws_access_key`, `google_api_key`, `private_key`, `jwt`, `email`, `uuid`, `ipv4`, `mac`, `china_phone`, `china_id`.

Placeholders are `HMAC-SHA256(key, value)` truncated to 12 hex chars. The key lives in `~/.config/opencode/vibeguard.key` (32 bytes, mode 0600, created on first run; override with `key_file`), so a secret keeps its placeholder across sessions and restarts.

Set `"debug": true` to log one line per request: `kind=<kind> replaced=<n>` and `guard=clean|BLOCKED`. Secrets are never logged.

## Limits

- Model replies on screen show placeholders; files and commands get the real values.
- Tools receive real values, so a tool that sends data out (`curl` in `bash`) can send a secret. This plugin keeps secrets away from the LLM provider, not from tools.
- Tool descriptions are not redacted; if one matches a rule, requests are blocked until the value is added to `patterns.exclude`.

## Develop

```bash
npm test          # unit tests, also run in CI
npm run test:e2e  # real `opencode run --standalone` against a local mock provider; needs opencode V2 on PATH
```

License: MIT (upstream).
````
`git rm README-zh.md`.

- [ ] **Step 4: Запустить все тесты**

Run: `npm test && npm run test:e2e`
Expected: PASS, всё.

- [ ] **Step 5: Commit**

```bash
git add README.md vibeguard.config.json.example .github/workflows/test.yml test/unit/docs.test.js
git commit -m "docs: V2 README, example config; ci: unit tests"
```

- [ ] **Step 6: Push — после подтверждения пользователя**

Остановиться и спросить. Затем:
```bash
git push -u origin v2-port
gh run watch --repo BohdanParkhomenkoNix/opencode-vibeguard --exit-status $(gh run list --repo BohdanParkhomenkoNix/opencode-vibeguard --branch v2-port --limit 1 --json databaseId --jq '.[0].databaseId')
```
Expected: workflow `test` — success.

- [ ] **Step 7: PR и merge в main — после подтверждения пользователя**

Остановиться и спросить. `--repo` обязателен, иначе `gh` откроет PR в upstream:
```bash
gh pr create --repo BohdanParkhomenkoNix/opencode-vibeguard --base main --head v2-port --title "OpenCode V2 port" --body "V2 hooks, persistent key, guard, strict config, unit + e2e tests. Spec: docs/superpowers/specs/2026-10-10-vibeguard-v2-port-design.md"
gh pr merge --repo BohdanParkhomenkoNix/opencode-vibeguard --merge v2-port
```
Expected: PR merged; CI на `main` — success.

---

### Task 14: Раскатка в OpenCode и живая проверка

**Files:**
- Modify: `~/.config/opencode/opencode.jsonc` (массив `plugins`)
- Create: `~/.config/opencode/vibeguard.config.json`
- Create: `~/.config/opencode/opencode.jsonc.bak-2026-10-10-vibeguard`

**Interfaces:**
- Consumes: `main` форка (Задача 13).
- Produces: vibeguard активен в сервисе OC.

- [ ] **Step 1: Подтверждение пользователя**

Остановиться и спросить разрешения на правку `~/.config/opencode` и рестарт сервиса.

- [ ] **Step 2: Бэкап и конфиг**

```bash
cp -a ~/.config/opencode/opencode.jsonc ~/.config/opencode/opencode.jsonc.bak-2026-10-10-vibeguard
cp ~/Projects/opencode-vibeguard/vibeguard.config.json.example ~/.config/opencode/vibeguard.config.json
```
В `opencode.jsonc` правкой Edit добавить в массив `plugins` последней строкой `"opencode-vibeguard@git+https://github.com/BohdanParkhomenkoNix/opencode-vibeguard.git"`.

- [ ] **Step 3: Рестарт и проверка загрузки**

```bash
env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" SHELL=/bin/zsh TERM=xterm-256color zsh -lic 'opencode service restart'
opencode plugin list; sleep 3; opencode plugin list
```
Expected: `opencode-vibeguard` в списке ровно один раз (первый вызов после рестарта может гонку проиграть — смотреть второй). Файл `~/.config/opencode/vibeguard.key` создан, права `-rw-------`.

- [ ] **Step 4: Живая проверка**

```bash
D=$(mktemp -d /tmp/vg-live.XXXX); V="vg-live-$RANDOM$RANDOM"
printf '{"enabled":true,"debug":true,"patterns":{"keywords":[{"value":"%s","category":"LIVE"}],"builtin":["email"]}}' "$V" > "$D/vibeguard.config.json"
cd "$D" && (opencode run --standalone --print-logs --auto -m opencode/big-pickle "My token is $V. Run bash: printf '%s' <the token> > out.txt" > "$D/run.log" 2>&1 & pid=$!; for i in $(seq 1 120); do kill -0 $pid 2>/dev/null || break; sleep 2; done; kill $pid 2>/dev/null)
grep -c 'guard=clean' "$D/run.log"; grep -c 'guard=BLOCKED' "$D/run.log"; [ "$(cat "$D/out.txt")" = "$V" ] && echo RESTORED
```
Expected: `guard=clean` ≥ 2, `guard=BLOCKED` = 0, `RESTORED`. Если строк `[vibeguard]` не видно (F10), сверить по `~/.local/share/opencode/log/opencode.log`.

- [ ] **Step 5: Уборка**

```bash
cd ~; rm -rf "$D"
~/.local/bin/codebase-memory-mcp cli --json delete_project "{\"project\":\"$(echo "${D#/}" | sed 's#^tmp#private-tmp#; s#[^A-Za-z0-9._-]#-#g')\"}"
```
Откат (не выполнять, только записать в отчёт): `cp -a ~/.config/opencode/opencode.jsonc.bak-2026-10-10-vibeguard ~/.config/opencode/opencode.jsonc` и рестарт сервиса.
