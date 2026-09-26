import type { ModelInfo } from '../models';

export type Json = Record<string, unknown>;

export interface ProviderRequest {
  // `/v1/messages` or `/v1/messages/count_tokens`.
  path: string;
  // The query string Claude Code sent (`?beta=true`), including the `?`.
  search: string;
  // The Anthropic Messages body, with `model` already set to the upstream id.
  body: Json;
  // Claude Code's request headers.
  headers: Headers;
  signal: AbortSignal;
}

// One configured upstream. Every provider answers in the Anthropic Messages
// wire format, whatever it speaks upstream.
export interface Provider {
  forward(req: ProviderRequest): Promise<Response>;
  listModels(): Promise<ModelInfo[]>;
  // The upstream is Anthropic's own API: Claude Code's betas, `metadata`, and
  // auto mode's server-side checks all reach it unchanged.
  readonly native: boolean;
}

export function anthropicError(status: number, type: string, message: string, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
