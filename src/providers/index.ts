import type { Config, ProviderConfig } from '../config';
import { resolveKey } from '../secrets';
import { createAnthropicProvider } from './anthropic';
import { createCodexProvider } from './codex';
import type { Provider } from './types';

export type { Provider, ProviderRequest } from './types';

export function createProvider(name: string, config: ProviderConfig, fetchImpl: typeof fetch = fetch): Provider {
  if (config.type === 'codex') return createCodexProvider(config, fetchImpl);
  return createAnthropicProvider(config, resolveKey(name, config.apiKey), fetchImpl);
}

export function createProviders(config: Config, fetchImpl: typeof fetch = fetch): Record<string, Provider> {
  return Object.fromEntries(
    Object.entries(config.providers).map(([name, provider]) => [name, createProvider(name, provider, fetchImpl)]),
  );
}
