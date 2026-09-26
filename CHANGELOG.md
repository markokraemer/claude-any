# Changelog

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
