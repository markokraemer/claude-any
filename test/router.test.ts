import { describe, expect, test } from 'bun:test';

import type { Config } from '../src/config';
import { createRouter, estimateTokens, patchStreamUsage } from '../src/router';

const config: Config = {
  providers: {
    kortix: { baseUrl: 'https://gw.test/', apiKey: 'keychain', authHeader: 'bearer', models: ['kimi-k3', 'deepinfra/tencent/Hy3'] },
    anthropic: { baseUrl: 'https://api.anthropic.test', apiKey: 'keychain', authHeader: 'x-api-key', forwardBetas: true, models: ['claude-sonnet-5'] },
  },
  defaultModel: 'kortix/kimi-k3',
};
const keys = { kortix: 'kgw_secret', anthropic: 'sk-ant-secret' };
const TOKEN = 'ca_router_token';

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fakeUpstream(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const call = {
      url,
      headers: Object.fromEntries(Object.entries(init.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
      body: JSON.parse(init.body as string),
    };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const sse = (...events: [string, unknown][]) =>
  new Response(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream', 'request-id': 'req_up_1' },
  });

function post(router: ReturnType<typeof createRouter>, body: unknown, headers: Record<string, string> = {}, path = '/v1/messages?beta=true') {
  return router.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14',
        'x-claude-code-session-id': 'sess-1',
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
}

const okJson = () => Response.json({ type: 'message', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 12, output_tokens: 1 } });

describe('router auth', () => {
  test('rejects a request without the router token', async () => {
    const { calls, fetchImpl } = fakeUpstream(okJson);
    const router = createRouter({ config, keys, token: TOKEN, fetchImpl });
    const res = await post(router, { model: 'kortix/kimi-k3', messages: [] }, { authorization: 'Bearer wrong' });
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  test('accepts the router token as x-api-key', async () => {
    const { fetchImpl } = fakeUpstream(okJson);
    const router = createRouter({ config, keys, token: TOKEN, fetchImpl });
    const res = await post(router, { model: 'kortix/kimi-k3', messages: [] }, { authorization: '', 'x-api-key': TOKEN });
    expect(res.status).toBe(200);
  });

  test('answers the HEAD connectivity probe without a token', async () => {
    const router = createRouter({ config, keys, token: TOKEN });
    const res = await router.fetch(new Request('http://127.0.0.1/api/hello', { method: 'HEAD' }));
    expect(res.status).toBe(200);
  });
});

describe('router routing', () => {
  test('strips the provider prefix and sends the provider key as a bearer token', async () => {
    const { calls, fetchImpl } = fakeUpstream(okJson);
    const router = createRouter({ config, keys, token: TOKEN, fetchImpl });
    await post(router, { model: 'kortix/deepinfra/tencent/Hy3', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] });
    expect(calls[0]!.url).toBe('https://gw.test/v1/messages');
    expect(calls[0]!.body.model).toBe('deepinfra/tencent/Hy3');
    expect(calls[0]!.body.max_tokens).toBe(5);
    expect(calls[0]!.headers.authorization).toBe('Bearer kgw_secret');
    expect(calls[0]!.headers['x-api-key']).toBeUndefined();
    // Betas are off for this provider; Claude Code session headers still go.
    expect(calls[0]!.headers['anthropic-beta']).toBeUndefined();
    expect(calls[0]!.headers['x-claude-code-session-id']).toBe('sess-1');
    expect(calls[0]!.headers['anthropic-version']).toBe('2023-06-01');
  });

  test('uses x-api-key and forwards betas and the query for a provider configured that way', async () => {
    const { calls, fetchImpl } = fakeUpstream(okJson);
    const router = createRouter({ config, keys, token: TOKEN, fetchImpl });
    await post(router, { model: 'anthropic/claude-sonnet-5', messages: [] });
    expect(calls[0]!.url).toBe('https://api.anthropic.test/v1/messages?beta=true');
    expect(calls[0]!.headers['x-api-key']).toBe('sk-ant-secret');
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(calls[0]!.headers['anthropic-beta']).toBe('claude-code-20250219,interleaved-thinking-2025-05-14');
  });

  test('sends an id without a provider prefix (a Claude Code background request) to the default model', async () => {
    const { calls, fetchImpl } = fakeUpstream(okJson);
    const router = createRouter({ config, keys, token: TOKEN, fetchImpl });
    await post(router, { model: 'claude-haiku-4-5-20251001', messages: [] });
    expect(calls[0]!.url).toBe('https://gw.test/v1/messages');
    expect(calls[0]!.body.model).toBe('kimi-k3');
  });

  test('routes count_tokens to the same provider', async () => {
    const { calls, fetchImpl } = fakeUpstream(() => Response.json({ input_tokens: 42 }));
    const router = createRouter({ config, keys, token: TOKEN, fetchImpl });
    const res = await post(router, { model: 'kortix/kimi-k3', messages: [] }, {}, '/v1/messages/count_tokens');
    expect(calls[0]!.url).toBe('https://gw.test/v1/messages/count_tokens');
    expect(await res.json()).toEqual({ input_tokens: 42 });
  });

  test('returns upstream errors unchanged so Claude Code can match their wording', async () => {
    const body = { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 250000 tokens > 200000 maximum' } };
    const { fetchImpl } = fakeUpstream(() => Response.json(body, { status: 400, headers: { 'request-id': 'req_9' } }));
    const router = createRouter({ config, keys, token: TOKEN, fetchImpl });
    const res = await post(router, { model: 'kortix/kimi-k3', messages: [] });
    expect(res.status).toBe(400);
    expect(res.headers.get('request-id')).toBe('req_9');
    expect(await res.json()).toEqual(body);
  });

  test('reports an unreachable provider as a 502 in the Anthropic error shape', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const router = createRouter({ config, keys, token: TOKEN, fetchImpl });
    const res = await post(router, { model: 'kortix/kimi-k3', messages: [] });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe('api_error');
  });

  test('lists every configured model in the Anthropic /v1/models shape', async () => {
    const router = createRouter({ config, keys, token: TOKEN });
    const res = await router.fetch(new Request('http://127.0.0.1/v1/models', { headers: { authorization: `Bearer ${TOKEN}` } }));
    const body = (await res.json()) as { data: { id: string }[] };
    expect(body.data.map((m) => m.id)).toEqual(['kortix/kimi-k3', 'kortix/deepinfra/tencent/Hy3', 'anthropic/claude-sonnet-5']);
  });
});

describe('usage estimate', () => {
  test('fills input_tokens on message_delta when the upstream reported none', async () => {
    const { fetchImpl } = fakeUpstream(() =>
      sse(
        ['message_start', { type: 'message_start', message: { id: 'm', usage: { input_tokens: 0, output_tokens: 0 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }],
        ['message_stop', { type: 'message_stop' }],
      ),
    );
    const router = createRouter({ config, keys, token: TOKEN, fetchImpl });
    const request = { model: 'kortix/kimi-k3', stream: true, messages: [{ role: 'user', content: 'x'.repeat(4000) }] };
    const res = await post(router, request);
    const text = await res.text();
    const delta = text.split('\n\n').find((e) => e.includes('"message_delta"'))!;
    const usage = JSON.parse(delta.split('data: ')[1]!).usage;
    expect(usage.output_tokens).toBe(3);
    expect(usage.input_tokens).toBe(estimateTokens(JSON.stringify({ ...request, model: 'kimi-k3' }).length));
    expect(res.headers.get('request-id')).toBe('req_up_1');
    expect(text).toContain('"text":"hi"');
  });

  test('leaves a stream alone when the upstream reported input usage', async () => {
    const original = [
      `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: {}, usage: { input_tokens: 900, output_tokens: 3 } })}\n\n`,
    ].join('');
    const stream = new Response(original).body!;
    expect(await new Response(patchStreamUsage(stream, 5)).text()).toBe(original);
  });

  test('handles events split across chunk boundaries', async () => {
    const payload = `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{},"usage":{"output_tokens":1}}\n\n`;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < payload.length; i += 7) controller.enqueue(encoder.encode(payload.slice(i, i + 7)));
        controller.close();
      },
    });
    const out = await new Response(patchStreamUsage(stream, 77)).text();
    expect(out).toContain('"input_tokens":77');
    expect(out.split('\n\n').filter(Boolean)).toHaveLength(2);
  });

  test('fills input_tokens in a non-streaming response that reported zero', async () => {
    const { fetchImpl } = fakeUpstream(() => Response.json({ type: 'message', content: [], usage: { input_tokens: 0, output_tokens: 2 } }));
    const router = createRouter({ config, keys, token: TOKEN, fetchImpl });
    const res = await post(router, { model: 'kortix/kimi-k3', messages: [] });
    expect(((await res.json()) as { usage: { input_tokens: number } }).usage.input_tokens).toBeGreaterThan(0);
  });

  test('is off when estimateMissingUsage is false', async () => {
    const { fetchImpl } = fakeUpstream(() => Response.json({ type: 'message', content: [], usage: { input_tokens: 0, output_tokens: 2 } }));
    const router = createRouter({ config: { ...config, estimateMissingUsage: false }, keys, token: TOKEN, fetchImpl });
    const res = await post(router, { model: 'kortix/kimi-k3', messages: [] });
    expect(((await res.json()) as { usage: { input_tokens: number } }).usage.input_tokens).toBe(0);
  });
});
