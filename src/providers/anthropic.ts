// Any endpoint that serves the Anthropic Messages API: `POST {baseUrl}/v1/messages`.
// Requests and responses pass through; only the model id, auth, and the
// fields a non-native upstream may reject are changed.

import type { AnthropicProviderConfig } from '../config';
import { type ModelInfo, normalizeModelList } from '../models';
import type { Provider, ProviderRequest } from './types';

// Response headers Claude Code reads for retries, rate limits, and request ids.
const PASS_RESPONSE_HEADERS = ['content-type', 'request-id', 'x-request-id', 'retry-after', 'x-should-retry'];

export function authHeaders(provider: AnthropicProviderConfig, key: string): Record<string, string> {
  return provider.authHeader === 'x-api-key' ? { 'x-api-key': key } : { authorization: `Bearer ${key}` };
}

// Anthropic's own API: Claude Code's betas and `metadata` are meant for it.
// Explicit `native` wins; the older `forwardBetas` flag means the same.
export function isNative(provider: AnthropicProviderConfig): boolean {
  if (typeof provider.native === 'boolean') return provider.native;
  if (typeof provider.forwardBetas === 'boolean') return provider.forwardBetas;
  try {
    return new URL(provider.baseUrl).hostname === 'api.anthropic.com';
  } catch {
    return false;
  }
}

export function createAnthropicProvider(
  config: AnthropicProviderConfig,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Provider {
  const native = isNative(config);
  const base = config.baseUrl.replace(/\/+$/, '');

  return {
    native,

    async forward(req: ProviderRequest): Promise<Response> {
      const body = { ...req.body };
      // `metadata.user_id` is Anthropic's abuse-tracking tag. Other upstreams
      // ignore it or reject the whole request ("Unsupported parameter: metadata").
      if (!native) delete body.metadata;

      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'anthropic-version': req.headers.get('anthropic-version') ?? '2023-06-01',
        ...authHeaders(config, key),
      };
      const beta = req.headers.get('anthropic-beta');
      if (beta && native) headers['anthropic-beta'] = beta;
      for (const [name, value] of req.headers) {
        if (name.startsWith('x-claude-code-') || name === 'user-agent') headers[name] = value;
      }

      const upstream = await fetchImpl(`${base}${req.path}${native ? req.search : ''}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: req.signal,
      });

      const out = new Headers();
      for (const name of PASS_RESPONSE_HEADERS) {
        const value = upstream.headers.get(name);
        if (value) out.set(name, value);
      }
      for (const [name, value] of upstream.headers) {
        if (name.startsWith('anthropic-ratelimit-')) out.set(name, value);
      }
      // Errors pass through unchanged: Claude Code's retries and reactive
      // compaction match on the upstream's own wording.
      return new Response(upstream.body, { status: upstream.status, headers: out });
    },

    async listModels(): Promise<ModelInfo[]> {
      const url = `${base}/v1/models?limit=1000`;
      const res = await fetchImpl(url, {
        headers: { ...authHeaders(config, key), 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`GET ${url} returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return normalizeModelList(await res.json());
    },
  };
}
