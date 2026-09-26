import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { codexCredential } from '../src/providers/codex/auth';
import { createCodexProvider } from '../src/providers/codex';
import {
  anthropicToResponses,
  collectAnthropicMessage,
  decodeReasoningSignature,
  encodeReasoningSignature,
  responsesToAnthropicSse,
} from '../src/providers/codex/translate';

type Json = Record<string, any>;

// ─── Request translation ─────────────────────────────────────────────────────

describe('anthropicToResponses', () => {
  test('maps system, tools, tool results, effort, and caching the way the ChatGPT backend accepts them', () => {
    const out = anthropicToResponses(
      {
        model: 'gpt-6-sol',
        system: [{ type: 'text', text: 'You are a coding agent.' }, { type: 'text', text: 'Be brief.' }],
        max_tokens: 32000,
        metadata: { user_id: '{"session_id":"s-1"}' },
        thinking: { type: 'adaptive', display: 'omitted' },
        output_config: { effort: 'high' },
        tools: [{ name: 'Bash', description: 'Run a command', input_schema: { type: 'object', properties: { command: { type: 'string' } } } }],
        messages: [
          { role: 'user', content: 'list files' },
          { role: 'assistant', content: [{ type: 'text', text: 'Listing.' }, { type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'ls' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'a.txt\nb.txt' }] },
        ],
      },
      'gpt-6-sol',
    );
    expect(out).toEqual({
      model: 'gpt-6-sol',
      instructions: 'You are a coding agent.\n\nBe brief.',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list files' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Listing.' }] },
        { type: 'function_call', call_id: 'call_1', name: 'Bash', arguments: '{"command":"ls"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'a.txt\nb.txt' },
      ],
      tools: [{ type: 'function', name: 'Bash', description: 'Run a command', parameters: { type: 'object', properties: { command: { type: 'string' } } }, strict: false }],
      tool_choice: 'auto',
      parallel_tool_calls: true,
      reasoning: { effort: 'high', summary: 'auto' },
      store: false,
      stream: true,
      include: ['reasoning.encrypted_content'],
      prompt_cache_key: 's-1',
    });
    // The backend rejects both.
    expect(out).not.toHaveProperty('max_output_tokens');
    expect(out).not.toHaveProperty('metadata');
  });

  test('replays a reasoning item from a thinking block signature, without its id', () => {
    const signature = encodeReasoningSignature({ id: 'rs_1', encrypted_content: 'ENC', summary: [{ type: 'summary_text', text: 'Plan' }] });
    const out = anthropicToResponses(
      {
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: [{ type: 'thinking', thinking: 'Plan', signature }, { type: 'text', text: 'Hello' }] },
          { role: 'user', content: 'again' },
        ],
      },
      'gpt-6-sol',
    );
    expect(out.input).toContainEqual({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'Plan' }], encrypted_content: 'ENC' });
    expect(decodeReasoningSignature('some-anthropic-signature')).toBeNull();
  });

  test('moves images returned by a tool into a user message after the function output', () => {
    const out = anthropicToResponses(
      {
        messages: [
          { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'a.png' } }] },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call_1',
                content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }],
              },
            ],
          },
        ],
      },
      'gpt-6-sol',
    );
    expect(out.input).toEqual([
      { type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{"file_path":"a.png"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '[1 image attached in the next message]' },
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'Image from tool result call_1:' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
        ],
      },
    ]);
  });

  test('drops a trailing assistant turn and maps mid-conversation system text to developer', () => {
    const out = anthropicToResponses(
      {
        messages: [
          { role: 'user', content: 'go' },
          { role: 'system', content: 'Reminder: tests must pass.' },
          { role: 'assistant', content: 'partial answ' },
        ],
      } as Json,
      'gpt-6-sol',
    );
    expect(out.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Reminder: tests must pass.' }] },
    ]);
  });

  test('maps thinking disabled to low effort and an unknown tier to medium', () => {
    expect((anthropicToResponses({ messages: [], thinking: { type: 'disabled' } }, 'm').reasoning as Json).effort).toBe('low');
    expect((anthropicToResponses({ messages: [], output_config: { effort: 'turbo' } }, 'm').reasoning as Json).effort).toBe('medium');
    expect(anthropicToResponses({ messages: [], tool_choice: { type: 'tool', name: 'Bash' } }, 'm').tool_choice).toEqual({ type: 'function', name: 'Bash' });
  });
});

// ─── Response translation ────────────────────────────────────────────────────

const responsesSse = (...events: Json[]) =>
  new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')).body!;

async function anthropicEvents(stream: ReadableStream<Uint8Array>): Promise<Json[]> {
  const text = await new Response(stream).text();
  return text.split('\n\n').filter(Boolean).map((block) => JSON.parse(block.split('\n').find((l) => l.startsWith('data:'))!.slice(5)));
}

// Recorded shapes from chatgpt.com/backend-api/codex/responses (ids shortened).
const created = { type: 'response.created', response: { id: 'resp_1' } };
const completed = (usage: Json, extra: Json = {}) => ({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', usage, ...extra } });

describe('responsesToAnthropicSse', () => {
  test('streams reasoning as a signed thinking block, then text, with cached tokens split out', async () => {
    const events = await anthropicEvents(
      responsesToAnthropicSse(
        responsesSse(
          created,
          { type: 'response.output_item.added', item: { id: 'rs_1', type: 'reasoning' } },
          { type: 'response.reasoning_summary_part.added' },
          { type: 'response.reasoning_summary_text.delta', delta: '**Solving**' },
          { type: 'response.output_item.done', item: { id: 'rs_1', type: 'reasoning', encrypted_content: 'ENC', summary: [{ type: 'summary_text', text: '**Solving**' }] } },
          { type: 'response.output_item.added', item: { id: 'msg_1', type: 'message' } },
          { type: 'response.output_text.delta', delta: 'The ball costs ' },
          { type: 'response.output_text.delta', delta: '$0.05.' },
          { type: 'response.output_item.done', item: { id: 'msg_1', type: 'message' } },
          completed({ input_tokens: 1200, input_tokens_details: { cached_tokens: 1000 }, output_tokens: 86 }),
        ),
        'gpt-6-sol',
      ),
    );
    expect(events.map((e) => e.type)).toEqual([
      'message_start',
      'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop',
      'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop',
      'message_delta', 'message_stop',
    ]);
    expect(events[1]!.content_block.type).toBe('thinking');
    expect(events[2]!.delta).toEqual({ type: 'thinking_delta', thinking: '**Solving**' });
    expect(decodeReasoningSignature(events[3]!.delta.signature)).toEqual({ type: 'reasoning', summary: [{ type: 'summary_text', text: '**Solving**' }], encrypted_content: 'ENC' });
    expect(events[5]!.content_block).toEqual({ type: 'text', text: '' });
    expect(events[9]).toEqual({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { input_tokens: 200, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 86 },
    });
  });

  test('streams a function call as tool_use with input_json_delta and stop_reason tool_use', async () => {
    const events = await anthropicEvents(
      responsesToAnthropicSse(
        responsesSse(
          created,
          { type: 'response.output_item.added', item: { id: 'fc_1', type: 'function_call', call_id: 'call_9', name: 'Bash' } },
          { type: 'response.function_call_arguments.delta', delta: '{"command":' },
          { type: 'response.function_call_arguments.delta', delta: '"echo hi"}' },
          { type: 'response.output_item.done', item: { id: 'fc_1', type: 'function_call', call_id: 'call_9', name: 'Bash', arguments: '{"command":"echo hi"}' } },
          completed({ input_tokens: 71, output_tokens: 19 }),
        ),
        'gpt-6-sol',
      ),
    );
    expect(events[1]!.content_block).toEqual({ type: 'tool_use', id: 'call_9', name: 'Bash', input: {} });
    expect(events.filter((e) => e.delta?.type === 'input_json_delta').map((e) => e.delta.partial_json).join('')).toBe('{"command":"echo hi"}');
    expect(events.find((e) => e.type === 'message_delta')!.delta.stop_reason).toBe('tool_use');
  });

  test('reports a length cut as max_tokens', async () => {
    const events = await anthropicEvents(
      responsesToAnthropicSse(
        responsesSse(created, { type: 'response.incomplete', response: { usage: { input_tokens: 5, output_tokens: 9 }, incomplete_details: { reason: 'max_output_tokens' } } }),
        'm',
      ),
    );
    expect(events.find((e) => e.type === 'message_delta')!.delta.stop_reason).toBe('max_tokens');
  });

  test('turns response.failed into an Anthropic error event; context overflow keeps the wording Claude Code compacts on', async () => {
    const events = await anthropicEvents(
      responsesToAnthropicSse(
        responsesSse(created, { type: 'response.failed', response: { error: { code: 'context_length_exceeded', message: 'Your input exceeds the context window.' } } }),
        'm',
      ),
    );
    expect(events.at(-1)).toEqual({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: Your input exceeds the context window.' } });
    expect(events.map((e) => e.type)).not.toContain('message_stop');
  });

  test('a stream that ends before response.completed is an error, not a normal end_turn', async () => {
    const events = await anthropicEvents(
      responsesToAnthropicSse(
        responsesSse(created, { type: 'response.output_item.added', item: { id: 'msg_1', type: 'message' } }, { type: 'response.output_text.delta', delta: 'half' }),
        'm',
      ),
    );
    expect(events.at(-1)!.type).toBe('error');
    expect(events.map((e) => e.type)).not.toContain('message_delta');
  });

  test('collects a non-streaming Messages response with parsed tool input', async () => {
    const { status, body } = await collectAnthropicMessage(
      responsesToAnthropicSse(
        responsesSse(
          created,
          { type: 'response.output_item.added', item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'Read' } },
          { type: 'response.function_call_arguments.delta', delta: '{"file_path":"a"}' },
          { type: 'response.output_item.done', item: { type: 'function_call' } },
          completed({ input_tokens: 3, output_tokens: 4 }),
        ),
        'gpt-6-luna',
      ),
    );
    expect(status).toBe(200);
    expect(body.content).toEqual([{ type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'a' } }]);
    expect(body.stop_reason).toBe('tool_use');
    expect(body.model).toBe('gpt-6-luna');
  });
});

// ─── Login and provider ──────────────────────────────────────────────────────

const jwt = (expSeconds: number) =>
  `h.${Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url')}.s`;

describe('codex login and provider', () => {
  let home: string;
  const authFile = () => join(home, 'auth.json');
  const writeAuth = (access: string, refresh = 'refresh-1') =>
    writeFileSync(authFile(), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: access, refresh_token: refresh, id_token: 'id-1', account_id: 'acct-1' }, last_refresh: 'x' }));

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'codex-home-'));
    process.env.CODEX_HOME = home;
  });
  afterEach(() => {
    delete process.env.CODEX_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  test('uses a valid token without refreshing', async () => {
    const valid = jwt(Date.now() / 1000 + 3600);
    writeAuth(valid);
    const fetchImpl = (async () => {
      throw new Error('must not refresh');
    }) as unknown as typeof fetch;
    expect(await codexCredential(fetchImpl)).toEqual({ access: valid, accountId: 'acct-1' });
  });

  test('refreshes an expiring token and writes the rotated tokens back in the Codex CLI format', async () => {
    writeAuth(jwt(Date.now() / 1000 + 60));
    const fresh = jwt(Date.now() / 1000 + 36000);
    let sent: Json = {};
    const fetchImpl = (async (url: string, init: RequestInit) => {
      expect(url).toBe('https://auth.openai.com/oauth/token');
      sent = JSON.parse(String(init.body));
      return Response.json({ access_token: fresh, refresh_token: 'refresh-2', id_token: 'id-2' });
    }) as unknown as typeof fetch;
    expect((await codexCredential(fetchImpl)).access).toBe(fresh);
    expect(sent).toEqual({ client_id: 'app_EMoamEEZ73f0CkXaXp7hrann', grant_type: 'refresh_token', refresh_token: 'refresh-1' });
    const saved = JSON.parse(readFileSync(authFile(), 'utf8'));
    expect(saved.tokens).toEqual({ access_token: fresh, refresh_token: 'refresh-2', id_token: 'id-2', account_id: 'acct-1' });
    expect(saved.auth_mode).toBe('chatgpt');
  });

  test('the provider sends the Codex headers and retries once with a new token after a 401', async () => {
    const stale = jwt(Date.now() / 1000 + 3600);
    const fresh = jwt(Date.now() / 1000 + 36000);
    writeAuth(stale);
    const seen: Array<{ url: string; headers: Json; body?: Json }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Json, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith('/oauth/token')) return Response.json({ access_token: fresh, refresh_token: 'refresh-2' });
      if ((init.headers as Json).authorization === `Bearer ${stale}`) return new Response('{"detail":"Unauthorized"}', { status: 401 });
      return new Response(
        [created, { type: 'response.output_item.added', item: { id: 'm', type: 'message' } }, { type: 'response.output_text.delta', delta: 'pong' }, completed({ input_tokens: 5, output_tokens: 1 })]
          .map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }) as unknown as typeof fetch;

    const provider = createCodexProvider({ type: 'codex', models: ['gpt-6-sol'] }, fetchImpl);
    const res = await provider.forward({
      path: '/v1/messages',
      search: '?beta=true',
      body: { model: 'gpt-6-sol', stream: true, messages: [{ role: 'user', content: 'ping' }] },
      headers: new Headers({ 'x-claude-code-session-id': 'sess-9' }),
      signal: new AbortController().signal,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('"text":"pong"');
    const calls = seen.filter((c) => c.url.endsWith('/responses'));
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(calls[1]!.headers).toMatchObject({ authorization: `Bearer ${fresh}`, 'chatgpt-account-id': 'acct-1', originator: 'codex_cli_rs' });
    expect(calls[1]!.body!.prompt_cache_key).toBe('sess-9');
  });

  test('count_tokens answers 404 so Claude Code falls back to its own estimate', async () => {
    writeAuth(jwt(Date.now() / 1000 + 3600));
    const provider = createCodexProvider({ type: 'codex', models: [] }, (async () => {
      throw new Error('no upstream call');
    }) as unknown as typeof fetch);
    const res = await provider.forward({ path: '/v1/messages/count_tokens', search: '', body: { model: 'm' }, headers: new Headers(), signal: new AbortController().signal });
    expect(res.status).toBe(404);
  });

  test('maps a backend rejection to the Anthropic error envelope with its reason', async () => {
    writeAuth(jwt(Date.now() / 1000 + 3600));
    const provider = createCodexProvider({ type: 'codex', models: [] }, (async () =>
      new Response('{"detail":"Unsupported parameter: foo"}', { status: 400 })) as unknown as typeof fetch);
    const res = await provider.forward({ path: '/v1/messages', search: '', body: { model: 'm', messages: [] }, headers: new Headers(), signal: new AbortController().signal });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ type: 'error', error: { type: 'invalid_request_error', message: 'Unsupported parameter: foo' } });
  });

  test('a missing login names the fix', async () => {
    const provider = createCodexProvider({ type: 'codex', models: [] });
    const res = await provider.forward({ path: '/v1/messages', search: '', body: { model: 'm', messages: [] }, headers: new Headers(), signal: new AbortController().signal });
    expect(res.status).toBe(401);
    expect(((await res.json()) as Json).error.message).toContain('codex login');
  });

  test('lists visible models as ChatGPT-plan rows with their context window', async () => {
    writeAuth(jwt(Date.now() / 1000 + 3600));
    const provider = createCodexProvider({ type: 'codex', models: [] }, (async (url: string) => {
      expect(url).toContain('/models?client_version=');
      return Response.json({ models: [
        { slug: 'gpt-6-sol', display_name: 'GPT-6-Sol', context_window: 272000, visibility: 'list' },
        { slug: 'codex-auto-review', display_name: 'Codex Auto Review', context_window: 272000, visibility: 'hide' },
      ] });
    }) as unknown as typeof fetch);
    expect(await provider.listModels()).toEqual([{ id: 'gpt-6-sol', name: 'GPT-6-Sol', contextTokens: 272000, subscription: 'ChatGPT plan' }]);
  });
});
