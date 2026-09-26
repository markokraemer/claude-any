import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type Config, parseModelRef } from '../src/config';
import { claudeEnv, restoreUserModel } from '../src/launch';
import { normalizeModelList } from '../src/models';
import { buildSettings, contextWindow, pickerOptions } from '../src/picker';

const config: Config = {
  providers: {
    kortix: { baseUrl: 'https://gw.test', apiKey: 'keychain', models: ['kimi-k3', 'glm-5.3-flash'], labels: { 'glm-5.3-flash': 'GLM Flash' } },
    zai: { baseUrl: 'https://z.test', apiKey: 'env:ZAI', models: ['glm-5'] },
  },
  defaultModel: 'kortix/kimi-k3',
  smallModel: 'kortix/glm-5.3-flash',
};

describe('parseModelRef', () => {
  test('splits on the first slash when the prefix is a configured provider', () => {
    expect(parseModelRef(config, 'kortix/deepinfra/tencent/Hy3')).toEqual({ provider: 'kortix', model: 'deepinfra/tencent/Hy3' });
    expect(parseModelRef(config, 'openai/gpt-5')).toBeNull();
    expect(parseModelRef(config, 'claude-sonnet-5')).toBeNull();
    expect(parseModelRef(config, 'kortix/kimi-k3[1m]')).toEqual({ provider: 'kortix', model: 'kimi-k3' });
  });
});

describe('normalizeModelList', () => {
  test('reads the Anthropic / OpenAI data array', () => {
    expect(normalizeModelList({ data: [{ id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' }, { id: 'gpt-5' }] })).toEqual([
      { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', contextTokens: undefined, inputCost: undefined, outputCost: undefined },
      { id: 'gpt-5', name: undefined, contextTokens: undefined, inputCost: undefined, outputCost: undefined },
    ]);
  });

  test('reads OpenRouter context and per-token pricing', () => {
    const [m] = normalizeModelList({ data: [{ id: 'x/y', name: 'Y', context_length: 262144, pricing: { prompt: '0.0000025', completion: '0.000014' } }] });
    expect(m!.contextTokens).toBe(262144);
    expect(m!.inputCost).toBeCloseTo(2.5);
    expect(m!.outputCost).toBeCloseTo(14);
  });

  test('marks Kortix ChatGPT models as billed to the plan, without API prices', () => {
    const [m] = normalizeModelList({ models: { 'codex/gpt-6-sol': { name: 'GPT-6 Sol (ChatGPT)', provider: 'codex', limit: { context: 1050000 }, cost: { input: 2, output: 10 } } } });
    expect(m).toEqual({ id: 'codex/gpt-6-sol', name: 'GPT-6 Sol (ChatGPT)', contextTokens: 1050000, subscription: 'ChatGPT plan' });
    expect(pickerOptions({ providers: { kortix: { baseUrl: 'x', apiKey: 'k', models: ['codex/gpt-6-sol'] } } }, { kortix: [m!] })[0]!.description)
      .toBe('kortix · 1.1M context · billed to ChatGPT plan');
  });

  test('reads the Kortix gateway models map', () => {
    expect(normalizeModelList({ models: { 'kimi-k3': { name: 'Kimi K3 2.8T', limit: { context: 1048576 }, cost: { input: 2.5, output: 14 } } } })).toEqual([
      { id: 'kimi-k3', name: 'Kimi K3 2.8T', contextTokens: 1048576, inputCost: 2.5, outputCost: 14 },
    ]);
  });
});

describe('picker', () => {
  const cache = { kortix: [{ id: 'kimi-k3', name: 'Kimi K3 2.8T', contextTokens: 1048576, inputCost: 2.5, outputCost: 14 }], zai: [{ id: 'glm-5', contextTokens: 200000 }] };

  test('builds one labeled row per model, replacing the built-in lineup', () => {
    expect(pickerOptions(config, cache)).toEqual([
      { model: 'kortix/kimi-k3', label: 'Kimi K3 2.8T', description: 'kortix · 1M context · $2.5/$14 per MTok' },
      { model: 'kortix/glm-5.3-flash', label: 'GLM Flash', description: 'kortix' },
      { model: 'zai/glm-5', label: 'glm-5', description: 'zai · 200K context' },
    ]);
    expect((buildSettings(config, cache).modelPicker as { replaceBuiltInOptions: boolean }).replaceBuiltInOptions).toBe(true);
  });

  test('assumes the smallest known context window unless one is configured', () => {
    expect(contextWindow(config, cache)).toBe(200000);
    expect(contextWindow({ ...config, maxContextTokens: 500000 }, cache)).toBe(500000);
    expect(contextWindow(config, {})).toBeUndefined();
  });
});

describe('claudeEnv', () => {
  test('points Claude Code at the router and maps every alias slot', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-should-not-leak';
    process.env.ANTHROPIC_MODEL = 'claude-opus-4-8';
    const env = claudeEnv(config, 'http://127.0.0.1:5555', 'ca_tok', 200000);
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_MODEL;
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:5555');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('ca_tok');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('kortix/kimi-k3');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('kortix/kimi-k3');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('kortix/glm-5.3-flash');
    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('200000');
    expect(env.CLAUDE_CODE_AUTO_MODE_SERVER).toBe('0');
  });
});

describe('auto mode server checks', () => {
  test('stay on when every provider passes Anthropic traffic through', () => {
    const anthropicOnly: Config = {
      providers: { anthropic: { baseUrl: 'https://api.anthropic.test', apiKey: 'keychain', authHeader: 'x-api-key', forwardBetas: true, models: ['claude-sonnet-5'] } },
      defaultModel: 'anthropic/claude-sonnet-5',
    };
    expect(claudeEnv(anthropicOnly, 'http://r', 't', undefined).CLAUDE_CODE_AUTO_MODE_SERVER).toBeUndefined();
  });

  test('respect a value the user already set', () => {
    process.env.CLAUDE_CODE_AUTO_MODE_SERVER = '1';
    const env = claudeEnv(config, 'http://r', 't', undefined);
    delete process.env.CLAUDE_CODE_AUTO_MODE_SERVER;
    expect(env.CLAUDE_CODE_AUTO_MODE_SERVER).toBe('1');
  });
});

describe('restoreUserModel', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claude-any-test-'));
    process.env.CLAUDE_CONFIG_DIR = dir;
  });
  afterEach(() => {
    delete process.env.CLAUDE_CONFIG_DIR;
    rmSync(dir, { recursive: true, force: true });
  });
  const settingsFile = () => join(dir, 'settings.json');

  test('puts back the model a plain claude used and returns the routed pick', () => {
    writeFileSync(settingsFile(), JSON.stringify({ model: 'kortix/glm-5.3-flash', theme: 'dark' }));
    expect(restoreUserModel(config, 'opus')).toBe('kortix/glm-5.3-flash');
    expect(JSON.parse(readFileSync(settingsFile(), 'utf8'))).toEqual({ model: 'opus', theme: 'dark' });
  });

  test('removes the key when there was none before', () => {
    writeFileSync(settingsFile(), JSON.stringify({ model: 'kortix/kimi-k3' }));
    expect(restoreUserModel(config, undefined)).toBe('kortix/kimi-k3');
    expect(JSON.parse(readFileSync(settingsFile(), 'utf8'))).toEqual({});
  });

  test('keeps a non-routed change the user made on purpose', () => {
    writeFileSync(settingsFile(), JSON.stringify({ model: 'sonnet' }));
    expect(restoreUserModel(config, 'opus')).toBeUndefined();
    expect(JSON.parse(readFileSync(settingsFile(), 'utf8'))).toEqual({ model: 'sonnet' });
  });
});
