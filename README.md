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

`patterns.exclude` entries match exactly or by domain: `example.com` also covers `a@example.com` and `a@mail.example.com`, but not `a@notexample.com`. Comparison ignores case. Domain matching applies only to address- or host-shaped matches (for example `user@example.com`, `api.example.com`); a credential such as `user:pass@localhost` is still masked. This applies to every rule, keywords included. For example, with `exclude: ["example.com"]` the keyword `boss@example.com` is not masked. Entries are trimmed and lowercased, and a leading `@` or `*.` is dropped, so `@example.com` and `*.example.com` both mean `example.com`, which also covers the domain itself and every host under it. A broad entry such as `com` or `io` exempts every address and host under it. One leading `*.` is the only wildcard: a `*` standing alone as another label (`a.*.example.com`, `@*.example.com`, `*.*.example.com`) can never match and is a config error.

`session.ttl` sets how long a mapping may stay unused before it is dropped (default `30d`); every use renews it. `"0s"` means mappings never expire by age (`session.max_mappings` still applies and drops the least recently used).

Mappings survive restarts in `store_file` (default `~/.local/share/opencode/vibeguard.store`; `""` keeps them in memory only), so a placeholder that only a compaction summary still holds is restored for tools in a new process. Several OpenCode processes share the file; each save merges with what is on disk. The file is AES-256-GCM encrypted with a key derived from `vibeguard.key`, mode 0600, and lives apart from the key so a sync of `~/.config/opencode` does not carry both. The encryption guards against that one file leaking on its own (a sync or a backup without the key), not against a process that can read your whole home directory: such a process can read the key and OpenCode's own `opencode.db` too. A corrupt store is moved aside to `<store>.corrupt-<time>` and the plugin starts empty; a store that exists but cannot be read (for example no permission) is never overwritten. A store written with another key is left untouched and this process keeps its mappings in memory only; give each key its own `store_file`.

Set `"debug": true` to log one line per request: `kind=<kind> replaced=<n>` and `guard=clean|BLOCKED`. Secrets are never logged.

## Limits

- Model replies on screen show placeholders; files and commands get the real values.
- A value made up by the model (it first appears in the model's own output, for example in the content of a `write`) is not masked or blocked in that session and its subagents: the provider wrote it, so it is no secret to the provider. In every other session it is masked as usual. A value sent to the model first stays a secret even when the model repeats it.
- A subagent whose prompt cannot be matched to its parent's `subagent` call masks the values its parent made up; the session still works.
- Values in the inputs of MCP or plugin tools are always treated as real data: a Code Mode script builds those inputs at run time, so the plugin learns what the model made up only from its own messages and from the built-in tools it calls directly.
- Tools receive real values, so a tool that sends data out (`curl` in `bash`) can send a secret. This plugin keeps secrets away from the LLM provider, not from tools.
- A secret inside escaped text (JSON strings, notebook cells, `read` output) is masked through up to 3 levels of JSON escaping, `\/` and `\uXXXX` included. Other JSON escape spellings (uppercase `\u00E4`-style hex, a doubly escaped `\/`) are still seen by the guard, which blocks the request; drop that message to continue. Deeper nesting and non-JSON encodings (base64, URL encoding) are not detected.
- A placeholder restores the exact text it replaced, so a secret copied into another format (for example a JSON-escaped PEM written to a `.pem` file) keeps the escaping it had where it was read. Move secrets between formats with a command on the file (`jq -r .private_key sa.json > key.pem`), not through the model.
- Tool descriptions are not redacted; if one matches a rule, requests are blocked until the value is added to `patterns.exclude`.
- opencode's own local logs and session storage keep plaintext; this plugin controls only what is sent to the LLM provider.

## Develop

```bash
npm test          # unit tests, also run in CI
npm run test:e2e  # real `opencode run --standalone` against a local mock provider; needs opencode V2 on PATH
```

License: MIT (upstream).
