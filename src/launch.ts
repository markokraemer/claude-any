import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { type Config, allModelIds, configDir, loadState, parseModelRef, saveState } from './config';
import { buildSettings, contextWindow, loadCaches } from './picker';
import { startRouter } from './router';
import { resolveKey } from './secrets';

export function resolveKeys(config: Config): Record<string, string> {
  return Object.fromEntries(
    Object.entries(config.providers).map(([name, provider]) => [name, resolveKey(name, provider.apiKey)]),
  );
}

// Claude Code writes a /model choice into the user settings file. Routed ids
// mean nothing to a plain `claude`, so the launcher restores that key after
// the session and keeps the choice in its own state instead.
const userSettingsPath = (): string => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json');

function readUserSettings(): Record<string, unknown> | null {
  const path = userSettingsPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function restoreUserModel(config: Config, before: unknown): string | undefined {
  const settings = readUserSettings();
  if (!settings) return undefined;
  const after = settings.model;
  if (after === before || typeof after !== 'string' || !parseModelRef(config, after)) return undefined;
  if (before === undefined) delete settings.model;
  else settings.model = before;
  writeFileSync(userSettingsPath(), `${JSON.stringify(settings, null, 2)}\n`);
  return after;
}

export function initialModel(config: Config): string | undefined {
  const last = loadState().lastModel;
  if (last && allModelIds(config).includes(last)) return last;
  return config.defaultModel;
}

export function claudeEnv(config: Config, routerUrl: string, token: string, window: number | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Any of these would send Claude Code somewhere other than the router.
  for (const name of [
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_CUSTOM_HEADERS',
  ]) delete env[name];

  env.ANTHROPIC_BASE_URL = routerUrl;
  env.ANTHROPIC_AUTH_TOKEN = token;
  const main = config.defaultModel;
  const small = config.smallModel ?? main;
  // Built-in aliases still resolve inside Claude Code: subagents pinned to
  // "sonnet"/"opus", the "Default" picker row, background "haiku" requests.
  if (main) {
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = main;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = main;
    env.ANTHROPIC_DEFAULT_FABLE_MODEL = main;
  }
  if (small) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = small;
  if (window) env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(window);
  return env;
}

export async function launch(config: Config, args: string[], claudeBin = process.env.CLAUDE_ANY_CLAUDE_BIN || 'claude'): Promise<number> {
  if (!allModelIds(config).length) {
    throw new Error('No models configured. Run `claude-any add kortix` then `claude-any enable kortix/<model>`.');
  }
  const keys = resolveKeys(config);
  const token = `ca_${randomBytes(24).toString('hex')}`;
  const router = startRouter({
    config,
    keys,
    token,
    logFile: process.env.CLAUDE_ANY_LOG || join(configDir(), 'router.log'),
  });

  const caches = loadCaches(config);
  const settings = buildSettings(config, caches);
  const explicitModel = args.some((a) => a === '--model' || a.startsWith('--model='));
  const model = initialModel(config);
  if (model && !explicitModel) settings.model = model;

  const settingsFile = join(tmpdir(), `claude-any-${process.pid}-${randomBytes(4).toString('hex')}.json`);
  writeFileSync(settingsFile, JSON.stringify(settings), { mode: 0o600 });

  const before = readUserSettings()?.model;
  const child = spawn(claudeBin, ['--settings', settingsFile, ...args], {
    stdio: 'inherit',
    env: claudeEnv(config, router.url, token, contextWindow(config, caches)),
  });

  // The terminal delivers Ctrl-C to the whole process group. Claude Code
  // handles it; the launcher must outlive it to restore state.
  const ignore = () => {};
  process.on('SIGINT', ignore);
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  process.on('SIGHUP', () => child.kill('SIGHUP'));

  const code = await new Promise<number>((resolve) => {
    child.on('error', (err) => {
      process.stderr.write(`claude-any: could not start "${claudeBin}": ${err.message}\n`);
      resolve(127);
    });
    child.on('exit', (status, signal) => resolve(status ?? (signal ? 128 + 1 : 1)));
  });

  process.off('SIGINT', ignore);
  rmSync(settingsFile, { force: true });
  router.stop();
  const picked = restoreUserModel(config, before);
  if (picked) saveState({ ...loadState(), lastModel: picked });
  return code;
}
