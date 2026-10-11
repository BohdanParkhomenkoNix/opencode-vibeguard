import { spawn } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "./tmp.js"

// V2 loads a plugin from a directory, not a file path; for a local directory it resolves <dir>/index… before package.json (docs/v2-facts.md R1a), so the repo root loads index.js.
export const PLUGIN_ENTRY = new URL("../..", import.meta.url).href.replace(/\/$/, "")

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
