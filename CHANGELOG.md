# Changelog

## 0.2.0 — 2026-09-26

- **Local Codex provider.** `claude-any add <name> --codex` serves GPT models
  from the ChatGPT plan behind `codex login`, straight from
  `chatgpt.com/backend-api/codex`, with no gateway. The router translates
  Anthropic Messages ⇄ OpenAI Responses: tools, tool results, images
  (including images a tool returns), reasoning effort, reasoning replay through
  thinking-block signatures, usage with cached tokens, stop reasons, errors
  (context overflow keeps Claude Code's compaction wording), and non-streaming
  requests. Tokens refresh and are written back in the Codex CLI's format.
- **Provider-neutral.** Presets and every gateway-specific rule are gone. A
  provider is either any Anthropic Messages API endpoint (`--base-url`) or the
  local Codex provider (`--codex`). `--native` marks Anthropic's own API
  (automatic for api.anthropic.com); `forwardBetas` in older configs still
  works.
- Providers behind one interface (`src/providers/`); the router only
  authenticates, routes, estimates missing usage, and logs.

## 0.1.1 — 2026-09-26

- Drop Anthropic `metadata` for non-Anthropic providers. The ChatGPT backend
  behind the Kortix gateway rejected every Claude Code turn with
  "Unsupported parameter: metadata"; `codex/*` models now work on
  `gateway.kortix.com` without a gateway change.

## 0.1.0 — 2026-09-26

First release.

- Local router: routes `provider/model` ids to Anthropic-compatible upstreams,
  strips the prefix and `[1m]` tags, keeps upstream keys out of the `claude`
  process, and authenticates Claude Code with a per-launch random token.
- `/model` lists exactly the configured models through a generated
  `modelPicker` lineup, with labels, context size, and price or
  "billed to ChatGPT plan".
- Keys in the macOS Keychain, or `env:VAR`.
- Built-in alias slots (opus, sonnet, fable, haiku) map to the configured
  default and small models, so subagents and background requests stay routed.
- Estimates `input_tokens` when an upstream reports none, so auto-compaction
  works.
- Restores `~/.claude/settings.json` after a session and keeps the last
  `/model` pick for the next launch.
- Sets `CLAUDE_CODE_AUTO_MODE_SERVER=0` for non-Anthropic providers, so auto
  mode runs its own classifier without the "isn't eligible" notice.
- Commands: `add`, `key`, `models`, `enable`, `disable`, `default`, `small`,
  `list`, `doctor`, `router`, `remove`, `--version`.
- Presets: kortix (verified), anthropic, openrouter, deepseek, moonshot, zai,
  minimax.
- End-to-end runner (`test/e2e/e2e.ts`) against the real `claude` binary.
