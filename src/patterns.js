function sanitizeCategory(input) {
  const raw = String(input ?? "").trim()
  if (!raw) return "TEXT"
  const upper = raw.toUpperCase()
  const safe = upper.replace(/[^A-Z0-9_]/g, "_").replace(/_+/g, "_")
  if (!safe) return "TEXT"
  return safe
}

/**
 * 将 Go 风格的 `(?i)` / `(?m)` 前缀做一个轻量兼容（仅处理“开头连续出现”的情况）。
 * @param {string} pattern
 * @param {string} flags
 */
function peelInlineFlags(pattern, flags) {
  let p = String(pattern ?? "")
  let f = String(flags ?? "")

  for (;;) {
    if (p.startsWith("(?i)")) {
      p = p.slice(4)
      if (!f.includes("i")) f += "i"
      continue
    }
    if (p.startsWith("(?m)")) {
      p = p.slice(4)
      if (!f.includes("m")) f += "m"
      continue
    }
    break
  }

  return { pattern: p, flags: f }
}

/**
 * 内置规则：从 VibeGuard 的 builtin 规则移植（做了 JS 兼容调整）。
 * 目标是“低配置成本 + 尽量覆盖”，不追求 100% 精准。
 */
const BUILTIN = new Map([
  [
    "email",
    {
      pattern: String.raw`[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}`,
      flags: "i",
      category: "EMAIL",
    },
  ],
  [
    "china_phone",
    {
      // 直接匹配手机号本体（用 lookaround 替代 Go 里的捕获组边界保留写法）
      pattern: String.raw`(?<!\d)1[3-9]\d{9}(?!\d)`,
      flags: "",
      category: "CHINA_PHONE",
    },
  ],
  [
    "china_id",
    {
      pattern: String.raw`(?<!\d)\d{17}[\dXx](?!\d)`,
      flags: "",
      category: "CHINA_ID",
    },
  ],
  [
    "uuid",
    {
      pattern: String.raw`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}`,
      flags: "",
      category: "UUID",
    },
  ],
  [
    "ipv4",
    {
      // 不校验每段 0-255；目标是覆盖常见情况
      pattern: String.raw`(?:\d{1,3}\.){3}\d{1,3}`,
      flags: "",
      category: "IPV4",
    },
  ],
  [
    "mac",
    {
      pattern: String.raw`(?:[0-9a-f]{2}:){5}[0-9a-f]{2}`,
      flags: "i",
      category: "MAC",
    },
  ],
  ["openai_key", { pattern: String.raw`(?<![A-Za-z0-9_-])sk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}`, flags: "", category: "OPENAI_KEY" }],
  ["anthropic_key", { pattern: String.raw`(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}`, flags: "", category: "ANTHROPIC_KEY" }],
  ["github_token", { pattern: String.raw`(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})`, flags: "", category: "GITHUB_TOKEN" }],
  ["aws_access_key", { pattern: String.raw`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`, flags: "", category: "AWS_ACCESS_KEY" }],
  ["google_api_key", { pattern: String.raw`(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}`, flags: "", category: "GOOGLE_API_KEY" }],
  ["private_key", { pattern: String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----`, flags: "", category: "PRIVATE_KEY" }],
  ["jwt", { pattern: String.raw`(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`, flags: "", category: "JWT" }],
])

export const BUILTIN_NAMES = [...BUILTIN.keys()]

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
 * One spelling per entry, decided once: `@example.com` and `*.example.com` mean `example.com`
 * (which also covers the domain itself and every host under it). Messages name the position only.
 */
function normalizeExclude(x, i) {
  if (typeof x !== "string") fail(`patterns.exclude[${i}] must be a string`)
  let entry = x.trim().toLowerCase()
  if (entry.startsWith("*.")) entry = entry.slice(2)
  if (entry.startsWith("@")) entry = entry.slice(1)
  if (!entry || /\s/.test(entry)) fail(`patterns.exclude[${i}] is empty or contains spaces`)
  return entry
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
    } catch {
      fail(`patterns.regex[${i}] (${category}) is not a valid regex`)
    }
    return { pattern: peeled.pattern, flags: peeled.flags, category }
  })

  for (const [i, name] of listOf(raw, "builtin").entries()) {
    if (typeof name !== "string") fail(`patterns.builtin[${i}] must be a string`)
    const rule = BUILTIN.get(name.trim())
    if (!rule) fail(`patterns.builtin[${i}] is not a known builtin rule; known: ${BUILTIN_NAMES.join(", ")}`)
    regex.push({ pattern: rule.pattern, flags: rule.flags, category: rule.category })
  }

  const exclude = new Set(listOf(raw, "exclude").map(normalizeExclude))
  return { keywords, regex, exclude }
}
