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

If the key file is readable by others, the plugin tightens it to 0600; if it cannot, every request is blocked.

`patterns.exclude` entries match exactly or by domain: `example.com` also covers `a@example.com` and `a@mail.example.com`, but not `a@notexample.com`. Comparison ignores case. This applies to every rule, keywords included. For example, with `exclude: ["example.com"]` the keyword `boss@example.com` is not masked.

`session.ttl` sets how long a mapping lives (default `24h`); `"0s"` means mappings never expire by age (`session.max_mappings` still applies).

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
