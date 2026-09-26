#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, readSync } from 'node:fs';

import { type AuthHeader, type Config, allModelIds, configPath, loadConfig, parseModelRef, saveConfig } from './config';
import { launch, resolveKeys } from './launch';
import { fetchModels, formatCost, formatTokens, readModelCache } from './models';
import { PRESETS } from './presets';
import { startRouter } from './router';
import { keychainAvailable, keychainDelete, keychainSet, resolveKey } from './secrets';

const HELP = `claude-any — Claude Code on any Anthropic-compatible model endpoint

Usage:
  claude-any [claude args…]            Start Claude Code through the router
  claude-any add <name> [options]      Add a provider (presets: ${Object.keys(PRESETS).join(', ')})
      --base-url <url>                 Anthropic-compatible base URL (router appends /v1/messages)
      --auth bearer|x-api-key          How the upstream reads the key (default: bearer)
      --key <key> | --key-env <VAR>    Key literal (stored in the macOS Keychain) or env var name
      --forward-betas                  Forward Claude Code's anthropic-beta header
  claude-any key <name>                Replace a provider's key (reads it from stdin or a hidden prompt)
  claude-any models <name> [search]    List the provider's models (* = in the /model picker)
  claude-any enable <provider/model>…  Add models to the /model picker
  claude-any disable <provider/model>… Remove models from the /model picker
  claude-any default <provider/model>  Model a new session starts on
  claude-any small <provider/model>    Model for background requests (titles, summaries)
  claude-any list                      Show providers and picker models
  claude-any doctor                    Send one short request to every provider
  claude-any router [--port N]         Run only the router and print the env for a plain \`claude\`
  claude-any remove <name>             Remove a provider and its key

Config: ${configPath()}
Pass \`--\` to hand an argument that looks like a subcommand to claude.`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
  args.splice(i, 2);
  return value;
}

function boolFlag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}

function readSecret(label: string): string {
  if (!process.stdin.isTTY) {
    return readFileSync(0, 'utf8').trim();
  }
  process.stderr.write(`${label}: `);
  spawnSync('stty', ['-echo'], { stdio: 'inherit' });
  try {
    const buf = Buffer.alloc(4096);
    let out = '';
    while (!out.includes('\n')) {
      const n = readSync(0, buf, 0, buf.length, null);
      if (n <= 0) break;
      out += buf.subarray(0, n).toString('utf8');
    }
    return out.trim();
  } finally {
    spawnSync('stty', ['echo'], { stdio: 'inherit' });
    process.stderr.write('\n');
  }
}

function storeKey(name: string, key: string): string {
  if (!key) throw new Error('Empty key');
  if (keychainAvailable()) {
    keychainSet(name, key);
    return 'keychain';
  }
  process.stderr.write('warning: no Keychain on this platform; the key is stored in the config file (mode 0600)\n');
  return key;
}

function requireModelIds(config: Config, ids: string[]): { provider: string; model: string }[] {
  if (!ids.length) throw new Error('Give at least one <provider/model>');
  return ids.map((id) => {
    const ref = parseModelRef(config, id);
    if (!ref) throw new Error(`"${id}" does not start with a configured provider (${Object.keys(config.providers).join(', ') || 'none'})`);
    return ref;
  });
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const config = loadConfig();

  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return 0;

    case 'add': {
      const name = rest.shift();
      if (!name || name.startsWith('-')) throw new Error('Usage: claude-any add <name> [--base-url URL] [--key KEY]');
      const preset = PRESETS[name];
      const baseUrl = flag(rest, '--base-url') ?? preset?.baseUrl;
      if (!baseUrl) throw new Error(`"${name}" is not a preset; pass --base-url`);
      const auth = (flag(rest, '--auth') ?? preset?.authHeader ?? 'bearer') as AuthHeader;
      if (auth !== 'bearer' && auth !== 'x-api-key') throw new Error('--auth must be bearer or x-api-key');
      const keyEnv = flag(rest, '--key-env');
      let key = flag(rest, '--key');
      const forwardBetas = boolFlag(rest, '--forward-betas') || preset?.forwardBetas || false;
      if (!keyEnv && !key) {
        if (preset) process.stderr.write(`Key: ${preset.keyHint}\n`);
        key = readSecret(`API key for ${name}`);
      }
      const apiKey = keyEnv ? `env:${keyEnv}` : storeKey(name, key!);
      const existing = config.providers[name];
      config.providers[name] = { baseUrl, apiKey, authHeader: auth, forwardBetas, models: existing?.models ?? [], labels: existing?.labels };
      saveConfig(config);
      console.log(`Added ${name} → ${baseUrl}`);
      try {
        const models = await fetchModels(name, config.providers[name]!, resolveKey(name, apiKey));
        console.log(`${models.length} models available. Next: claude-any models ${name}   then   claude-any enable ${name}/<model>`);
      } catch (err) {
        console.log(`Model list unavailable (${(err as Error).message.slice(0, 120)}). Enable models by id: claude-any enable ${name}/<model>`);
      }
      return 0;
    }

    case 'key': {
      const name = rest[0];
      const provider = name ? config.providers[name] : undefined;
      if (!name || !provider) throw new Error(`Unknown provider "${name ?? ''}"`);
      provider.apiKey = storeKey(name, readSecret(`API key for ${name}`));
      saveConfig(config);
      console.log(`Updated the key for ${name}`);
      return 0;
    }

    case 'remove': {
      const name = rest[0];
      if (!name || !config.providers[name]) throw new Error(`Unknown provider "${name ?? ''}"`);
      if (config.providers[name]!.apiKey === 'keychain') keychainDelete(name);
      delete config.providers[name];
      for (const k of ['defaultModel', 'smallModel'] as const) {
        if (config[k]?.startsWith(`${name}/`)) delete config[k];
      }
      saveConfig(config);
      console.log(`Removed ${name}`);
      return 0;
    }

    case 'models': {
      const [name, search] = rest;
      const provider = name ? config.providers[name] : undefined;
      if (!name || !provider) throw new Error(`Unknown provider "${name ?? ''}". Configured: ${Object.keys(config.providers).join(', ') || 'none'}`);
      let models = readModelCache(name);
      try {
        models = await fetchModels(name, provider, resolveKey(name, provider.apiKey));
      } catch (err) {
        if (!models.length) throw err;
        process.stderr.write(`warning: showing cached list (${(err as Error).message.slice(0, 120)})\n`);
      }
      const needle = search?.toLowerCase();
      const rows = models.filter((m) => !needle || m.id.toLowerCase().includes(needle) || m.name?.toLowerCase().includes(needle));
      for (const m of rows) {
        const on = provider.models.includes(m.id) ? '*' : ' ';
        console.log(`${on} ${name}/${m.id}  ${[m.name, formatTokens(m.contextTokens), formatCost(m)].filter(Boolean).join(' · ')}`);
      }
      console.log(`${rows.length} of ${models.length} models`);
      return 0;
    }

    case 'enable':
    case 'disable': {
      for (const { provider, model } of requireModelIds(config, rest)) {
        const list = config.providers[provider]!.models;
        if (command === 'enable' && !list.includes(model)) list.push(model);
        if (command === 'disable') config.providers[provider]!.models = list.filter((m) => m !== model);
      }
      if (command === 'enable') config.defaultModel ??= rest[0];
      if (config.defaultModel && !allModelIds(config).includes(config.defaultModel)) delete config.defaultModel;
      if (config.smallModel && !allModelIds(config).includes(config.smallModel)) delete config.smallModel;
      saveConfig(config);
      console.log(`Picker: ${allModelIds(config).join(', ') || '(empty)'}`);
      return 0;
    }

    case 'default':
    case 'small': {
      const [{ provider, model }] = requireModelIds(config, rest.slice(0, 1)) as [{ provider: string; model: string }];
      const id = `${provider}/${model}`;
      if (!config.providers[provider]!.models.includes(model)) config.providers[provider]!.models.push(model);
      if (command === 'default') config.defaultModel = id;
      else config.smallModel = id;
      saveConfig(config);
      console.log(`${command === 'default' ? 'Default' : 'Small'} model: ${id}`);
      return 0;
    }

    case 'list': {
      for (const [name, p] of Object.entries(config.providers)) {
        const key = p.apiKey === 'keychain' ? 'Keychain' : p.apiKey.startsWith('env:') ? `$${p.apiKey.slice(4)}` : 'config file';
        console.log(`${name}  ${p.baseUrl}  (key: ${key}, auth: ${p.authHeader ?? 'bearer'})`);
        for (const m of p.models) console.log(`    ${name}/${m}`);
      }
      console.log(`default: ${config.defaultModel ?? '-'}   small: ${config.smallModel ?? config.defaultModel ?? '-'}`);
      return 0;
    }

    case 'doctor': {
      let failures = 0;
      for (const [name, p] of Object.entries(config.providers)) {
        const model = p.models[0];
        if (!model) {
          console.log(`- ${name}: no models enabled`);
          continue;
        }
        const token = `ca_${randomBytes(12).toString('hex')}`;
        let key: string;
        try {
          key = resolveKey(name, p.apiKey);
        } catch (err) {
          console.log(`✗ ${name}: ${(err as Error).message}`);
          failures++;
          continue;
        }
        const router = startRouter({ config, keys: { [name]: key }, token });
        const started = Date.now();
        const res = await fetch(`${router.url}/v1/messages`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: `${name}/${model}`, max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'Reply with exactly: ok' }] }),
        });
        const text = await res.text();
        router.stop();
        const ok = res.ok && text.includes('message_stop') && !text.includes('event: error');
        if (!ok) failures++;
        console.log(`${ok ? '✓' : '✗'} ${name}/${model}: HTTP ${res.status} in ${Date.now() - started}ms${ok ? '' : ` — ${text.slice(0, 200)}`}`);
      }
      return failures ? 1 : 0;
    }

    case 'router': {
      const port = Number(flag(rest, '--port') ?? 0);
      const token = `ca_${randomBytes(24).toString('hex')}`;
      const router = startRouter({ config, keys: resolveKeys(config), token, port });
      console.log(`export ANTHROPIC_BASE_URL=${router.url}\nexport ANTHROPIC_AUTH_TOKEN=${token}\n# models: ${allModelIds(config).join(' ')}`);
      await new Promise(() => {});
      return 0;
    }

    default: {
      const args = command === '--' ? rest : argv;
      return launch(config, args);
    }
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: Error) => {
    process.stderr.write(`claude-any: ${err.message}\n`);
    process.exit(1);
  });
