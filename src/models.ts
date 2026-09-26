import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { configDir, type ProviderConfig } from './config';
import { authHeaders } from './router';

export interface ModelInfo {
  id: string;
  name?: string;
  contextTokens?: number;
  // USD per million tokens.
  inputCost?: number;
  outputCost?: number;
  // Set when the upstream says the model runs on a subscription rather than
  // per-token pricing (Kortix gateway: `provider: "codex"` = ChatGPT plan).
  subscription?: string;
}

const num = (value: unknown): number | undefined => {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};

// Three list shapes exist in the wild:
//  - Anthropic / OpenAI: `{ data: [{ id, display_name | name, ... }] }`
//  - OpenRouter: the same `data` array with `context_length` and per-token
//    `pricing.prompt` / `pricing.completion` strings
//  - Kortix gateway (models.dev style): `{ models: { <id>: { name, limit, cost } } }`
export function normalizeModelList(body: unknown): ModelInfo[] {
  if (!body || typeof body !== 'object') return [];
  const root = body as Record<string, unknown>;

  if (Array.isArray(root.data)) {
    return root.data.flatMap((entry): ModelInfo[] => {
      if (!entry || typeof entry !== 'object') return [];
      const m = entry as Record<string, unknown>;
      if (typeof m.id !== 'string') return [];
      const pricing = (m.pricing as Record<string, unknown> | undefined) ?? {};
      const perToken = (v: unknown) => {
        const n = num(v);
        return n === undefined ? undefined : n * 1_000_000;
      };
      return [{
        id: m.id,
        name: typeof m.display_name === 'string' ? m.display_name : typeof m.name === 'string' ? m.name : undefined,
        contextTokens: num(m.context_length) ?? num(m.context_window) ?? num(m.max_input_tokens),
        inputCost: perToken(pricing.prompt),
        outputCost: perToken(pricing.completion),
      }];
    });
  }

  if (root.models && typeof root.models === 'object' && !Array.isArray(root.models)) {
    return Object.entries(root.models as Record<string, Record<string, unknown>>).map(([id, m]) => {
      const limit = (m?.limit as Record<string, unknown> | undefined) ?? {};
      const cost = (m?.cost as Record<string, unknown> | undefined) ?? {};
      const subscription = m?.provider === 'codex' ? 'ChatGPT plan' : undefined;
      return {
        id,
        name: typeof m?.name === 'string' ? m.name : undefined,
        contextTokens: num(limit.context),
        ...(subscription ? { subscription } : { inputCost: num(cost.input), outputCost: num(cost.output) }),
      };
    });
  }

  return [];
}

const cachePath = (provider: string): string => join(configDir(), 'cache', `${provider}.json`);

export function readModelCache(provider: string): ModelInfo[] {
  const path = cachePath(provider);
  if (!existsSync(path)) return [];
  try {
    return (JSON.parse(readFileSync(path, 'utf8')) as { models: ModelInfo[] }).models ?? [];
  } catch {
    return [];
  }
}

export async function fetchModels(
  name: string,
  provider: ProviderConfig,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelInfo[]> {
  const url = `${provider.baseUrl.replace(/\/+$/, '')}/v1/models?limit=1000`;
  const res = await fetchImpl(url, {
    headers: { ...authHeaders(provider, key), 'anthropic-version': '2023-06-01' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`GET ${url} returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const models = normalizeModelList(await res.json());
  mkdirSync(join(configDir(), 'cache'), { recursive: true });
  writeFileSync(cachePath(name), JSON.stringify({ fetchedAt: new Date().toISOString(), models }));
  return models;
}

export function formatTokens(n: number | undefined): string {
  if (!n) return '';
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  return `${Math.round(n / 1000)}K`;
}

export function formatCost(info: ModelInfo | undefined): string {
  if (info?.subscription) return `billed to ${info.subscription}`;
  if (info?.inputCost === undefined || info.outputCost === undefined) return '';
  const f = (n: number) => `$${n < 1 ? +n.toFixed(3) : +n.toFixed(2)}`;
  return `${f(info.inputCost)}/${f(info.outputCost)} per MTok`;
}
