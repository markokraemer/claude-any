import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// How the upstream expects the key. Anthropic itself reads `x-api-key`; most
// Anthropic-compatible gateways read `Authorization: Bearer`.
export type AuthHeader = 'bearer' | 'x-api-key';

export interface ProviderConfig {
  baseUrl: string;
  // `keychain` (macOS Keychain, service "claude-any", account = provider
  // name), `env:NAME`, or a literal key.
  apiKey: string;
  authHeader?: AuthHeader;
  // Forward Claude Code's `anthropic-beta` header. On for Anthropic itself;
  // off elsewhere because some compatible endpoints reject unknown betas.
  forwardBetas?: boolean;
  // Model ids as the upstream names them, without the provider prefix.
  models: string[];
  // Optional picker labels, keyed by upstream model id.
  labels?: Record<string, string>;
}

export interface Config {
  providers: Record<string, ProviderConfig>;
  // `provider/model` used when a session starts.
  defaultModel?: string;
  // `provider/model` for Claude Code's background requests (titles,
  // summaries), which it sends to its "haiku" slot.
  smallModel?: string;
  // Context window Claude Code assumes for every routed model. Unset: the
  // smallest known window across configured models.
  maxContextTokens?: number;
  // Inject an estimated `input_tokens` when an upstream reports none, so
  // Claude Code's auto-compaction still triggers. Default true.
  estimateMissingUsage?: boolean;
}

export interface State {
  // Last model picked in /model, restored at the next launch.
  lastModel?: string;
}

export function configDir(): string {
  if (process.env.CLAUDE_ANY_HOME) return process.env.CLAUDE_ANY_HOME;
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(xdg, 'claude-any');
}

export const configPath = (): string => join(configDir(), 'config.json');
const statePath = (): string => join(configDir(), 'state.json');

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`);
  }
}

// Write through a temp file so a crash never leaves half a config behind.
function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function loadConfig(): Config {
  const config = readJson<Config>(configPath(), { providers: {} });
  config.providers ??= {};
  return config;
}

export const saveConfig = (config: Config): void => writeJson(configPath(), config);
export const loadState = (): State => readJson<State>(statePath(), {});
export const saveState = (state: State): void => writeJson(statePath(), state);

export interface ModelRef {
  provider: string;
  model: string;
}

// `kortix/deepinfra/tencent/Hy3` -> provider `kortix`, model
// `deepinfra/tencent/Hy3`. Only a configured provider name counts as a prefix.
export function parseModelRef(config: Config, rawId: string): ModelRef | null {
  // Claude Code may append a context tag such as `[1m]`; upstreams never
  // know it.
  const id = rawId.replace(/\[[^\]]*\]$/, '');
  const slash = id.indexOf('/');
  if (slash <= 0) return null;
  const provider = id.slice(0, slash);
  if (!config.providers[provider]) return null;
  return { provider, model: id.slice(slash + 1) };
}

export function allModelIds(config: Config): string[] {
  return Object.entries(config.providers).flatMap(([name, provider]) =>
    provider.models.map((model) => `${name}/${model}`),
  );
}
