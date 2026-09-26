// Local Codex provider: GPT models on the ChatGPT plan behind `codex login`,
// served straight from https://chatgpt.com/backend-api/codex. The Anthropic
// Messages traffic Claude Code sends is translated on this machine; no
// gateway sits in between.

import type { CodexProviderConfig } from '../../config';
import type { ModelInfo } from '../../models';
import { anthropicError, type Provider, type ProviderRequest } from '../types';
import { codexCredential, codexHeaders } from './auth';
import { anthropicToResponses, codexErrorResponse, collectAnthropicMessage, responsesToAnthropicSse } from './translate';

export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
// The backend's model list is versioned by client; this is the Codex CLI
// release the translation was verified against.
const CLIENT_VERSION = process.env.CLAUDE_ANY_CODEX_CLIENT_VERSION || '0.157.1';

export function createCodexProvider(config: CodexProviderConfig, fetchImpl: typeof fetch = fetch): Provider {
  const base = (config.baseUrl || CODEX_BASE_URL).replace(/\/+$/, '');

  const post = async (payload: string, signal: AbortSignal): Promise<Response> => {
    const credential = await codexCredential(fetchImpl);
    const send = (access: typeof credential) =>
      fetchImpl(`${base}/responses`, {
        method: 'POST',
        headers: { ...codexHeaders(access), accept: 'text/event-stream' },
        body: payload,
        signal,
      });
    const res = await send(credential);
    if (res.status !== 401) return res;
    // A token the backend refused although it looked valid: get a new one once.
    await res.body?.cancel();
    return send(await codexCredential(fetchImpl, credential.access));
  };

  return {
    native: false,

    async forward(req: ProviderRequest): Promise<Response> {
      // The backend has no token counter. Claude Code falls back to its own
      // character-based estimate on a 404.
      if (req.path.endsWith('/count_tokens')) {
        return anthropicError(404, 'not_found_error', 'claude-any: token counting is not available for Codex models');
      }
      const model = String(req.body.model ?? '');
      let payload: string;
      try {
        payload = JSON.stringify(anthropicToResponses(req.body, model, req.headers.get('x-claude-code-session-id')));
      } catch (err) {
        return anthropicError(400, 'invalid_request_error', `claude-any: could not translate the request: ${(err as Error).message}`);
      }

      let res: Response;
      try {
        res = await post(payload, req.signal);
      } catch (err) {
        if (req.signal.aborted) throw err;
        // Login problems (no auth.json, refresh refused) name the fix.
        return anthropicError(401, 'authentication_error', `claude-any: ${(err as Error).message}`);
      }
      if (!res.ok || !res.body) return codexErrorResponse(res);

      const stream = responsesToAnthropicSse(res.body, model);
      if (req.body.stream === true) {
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      const { status, body } = await collectAnthropicMessage(stream);
      return Response.json(body, { status });
    },

    async listModels(): Promise<ModelInfo[]> {
      const credential = await codexCredential(fetchImpl);
      const res = await fetchImpl(`${base}/models?client_version=${encodeURIComponent(CLIENT_VERSION)}`, {
        headers: codexHeaders(credential),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`Codex model list returned ${res.status}`);
      const models = ((await res.json()) as { models?: Array<Record<string, unknown>> }).models ?? [];
      return models
        .filter((m) => m.visibility !== 'hide' && typeof m.slug === 'string')
        .map((m) => ({
          id: m.slug as string,
          name: typeof m.display_name === 'string' ? m.display_name : undefined,
          contextTokens: typeof m.context_window === 'number' ? m.context_window : undefined,
          subscription: 'ChatGPT plan',
        }));
    },
  };
}
