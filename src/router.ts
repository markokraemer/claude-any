import { appendFileSync } from 'node:fs';

import { type Config, type ProviderConfig, parseModelRef } from './config';

export interface RouterOptions {
  config: Config;
  // Resolved upstream keys, by provider name.
  keys: Record<string, string>;
  // Shared secret Claude Code must present. Keeps other local processes from
  // spending the upstream keys through the open port.
  token: string;
  fetchImpl?: typeof fetch;
  logFile?: string;
}

export function authHeaders(provider: ProviderConfig, key: string): Record<string, string> {
  return provider.authHeader === 'x-api-key' ? { 'x-api-key': key } : { authorization: `Bearer ${key}` };
}

function anthropicError(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Response headers Claude Code reads for retries, rate limits, and request ids.
const PASS_RESPONSE_HEADERS = [
  'content-type',
  'request-id',
  'x-request-id',
  'retry-after',
  'x-should-retry',
];

function presentedToken(req: Request): string | null {
  const auth = req.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  return auth?.trim() || req.headers.get('x-api-key')?.trim() || null;
}

// Rough token count for a request whose upstream reported no input usage.
// Claude Code compacts on reported usage; without any number it never does,
// and a long session ends in a context-length error instead.
export const estimateTokens = (bodyBytes: number): number => Math.ceil(bodyBytes / 4);

const hasInputUsage = (usage: Record<string, unknown> | undefined): boolean =>
  ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].some(
    (k) => typeof usage?.[k] === 'number' && (usage[k] as number) > 0,
  );

// Pass an Anthropic SSE stream through byte for byte, except a message_delta
// that closes a message whose usage never carried input tokens: that one
// gets `input_tokens` set to the estimate.
export function patchStreamUsage(stream: ReadableStream<Uint8Array>, estimate: number): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let reported = false;

  const rewrite = (event: string): string => {
    const dataLine = event.split('\n').find((line) => line.startsWith('data:'));
    if (!dataLine) return event;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(dataLine.slice(5));
    } catch {
      return event;
    }
    if (data.type === 'message_start') {
      reported ||= hasInputUsage((data.message as Record<string, unknown> | undefined)?.usage as Record<string, unknown>);
      return event;
    }
    if (data.type !== 'message_delta') return event;
    const usage = (data.usage as Record<string, unknown> | undefined) ?? {};
    if (reported || hasInputUsage(usage)) return event;
    data.usage = { ...usage, input_tokens: estimate };
    return event.replace(dataLine, `data: ${JSON.stringify(data)}`);
  };

  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
        let end = buffer.indexOf('\n\n');
        while (end >= 0) {
          controller.enqueue(encoder.encode(`${rewrite(buffer.slice(0, end))}\n\n`));
          buffer = buffer.slice(end + 2);
          end = buffer.indexOf('\n\n');
        }
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer) controller.enqueue(encoder.encode(rewrite(buffer)));
      },
    }),
  );
}

export function createRouter(opts: RouterOptions) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { config } = opts;

  const log = (line: string) => {
    if (opts.logFile) appendFileSync(opts.logFile, `${new Date().toISOString()} ${line}\n`);
  };

  const listModels = (): Response => {
    const data = Object.entries(config.providers).flatMap(([name, provider]) =>
      provider.models.map((model) => ({
        type: 'model',
        id: `${name}/${model}`,
        display_name: provider.labels?.[model] ?? model,
        created_at: '1970-01-01T00:00:00Z',
      })),
    );
    return Response.json({ data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null });
  };

  const forward = async (req: Request, url: URL): Promise<Response> => {
    const raw = await req.text();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return anthropicError(400, 'invalid_request_error', 'Request body is not valid JSON');
    }

    const requested = typeof body.model === 'string' ? body.model : '';
    // Ids without a configured provider prefix are Claude Code's own
    // (`claude-haiku-…` for a background task, `claude-sonnet-…` for a
    // subagent pinned to "sonnet"). They run on the default model.
    const ref = parseModelRef(config, requested) ?? (config.defaultModel ? parseModelRef(config, config.defaultModel) : null);
    if (!ref) {
      return anthropicError(
        404,
        'not_found_error',
        `claude-any: "${requested}" has no provider prefix and no defaultModel is set. Configured providers: ${Object.keys(config.providers).join(', ') || 'none'}.`,
      );
    }
    const provider = config.providers[ref.provider]!;
    const key = opts.keys[ref.provider];
    if (!key) return anthropicError(401, 'authentication_error', `claude-any: no key loaded for provider "${ref.provider}"`);

    body.model = ref.model;
    // `metadata.user_id` is Anthropic's abuse-tracking tag. Other upstreams
    // either ignore it or reject the request (the ChatGPT backend behind the
    // Kortix gateway: "Unsupported parameter: metadata").
    if (!provider.forwardBetas) delete body.metadata;
    const outgoing = JSON.stringify(body);

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': req.headers.get('anthropic-version') ?? '2023-06-01',
      ...authHeaders(provider, key),
    };
    const beta = req.headers.get('anthropic-beta');
    if (beta && provider.forwardBetas) headers['anthropic-beta'] = beta;
    for (const [name, value] of req.headers) {
      if (name.startsWith('x-claude-code-') || name === 'user-agent') headers[name] = value;
    }

    const search = provider.forwardBetas ? url.search : '';
    const target = `${provider.baseUrl.replace(/\/+$/, '')}${url.pathname}${search}`;
    const started = Date.now();
    let upstream: Response;
    try {
      upstream = await fetchImpl(target, { method: 'POST', headers, body: outgoing, signal: req.signal });
    } catch (err) {
      if (req.signal.aborted) return new Response(null, { status: 499 });
      log(`${requested} -> ${ref.provider}/${ref.model} network error ${(err as Error).message}`);
      return anthropicError(502, 'api_error', `claude-any: ${ref.provider} unreachable: ${(err as Error).message}`);
    }
    log(`${url.pathname} ${requested} -> ${ref.provider}/${ref.model} ${upstream.status} ${Date.now() - started}ms`);

    const responseHeaders = new Headers();
    for (const name of PASS_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    for (const [name, value] of upstream.headers) {
      if (name.startsWith('anthropic-ratelimit-')) responseHeaders.set(name, value);
    }

    const estimate = config.estimateMissingUsage === false || url.pathname.endsWith('/count_tokens')
      ? null
      : estimateTokens(outgoing.length);
    const contentType = upstream.headers.get('content-type') ?? '';

    if (upstream.ok && estimate !== null && upstream.body && contentType.includes('text/event-stream')) {
      return new Response(patchStreamUsage(upstream.body, estimate), { status: upstream.status, headers: responseHeaders });
    }
    if (upstream.ok && estimate !== null && contentType.includes('application/json')) {
      const json = (await upstream.json()) as Record<string, unknown>;
      const usage = json.usage as Record<string, unknown> | undefined;
      if (usage && !hasInputUsage(usage)) json.usage = { ...usage, input_tokens: estimate };
      return new Response(JSON.stringify(json), { status: upstream.status, headers: responseHeaders });
    }
    // Errors pass through unchanged: Claude Code's retry and reactive
    // compaction match on the upstream's own wording.
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  };

  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      // Claude Code probes the base URL before the first request.
      if (req.method === 'HEAD' || (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/api/hello'))) {
        return new Response(null, { status: 200 });
      }
      if (presentedToken(req) !== opts.token) {
        return anthropicError(401, 'authentication_error', 'claude-any: invalid router token');
      }
      if (req.method === 'GET' && url.pathname === '/v1/models') return listModels();
      if (req.method === 'POST' && (url.pathname === '/v1/messages' || url.pathname === '/v1/messages/count_tokens')) {
        return forward(req, url);
      }
      return anthropicError(404, 'not_found_error', `claude-any: ${req.method} ${url.pathname} is not routed`);
    },
  };
}

export function startRouter(opts: RouterOptions & { port?: number }) {
  const router = createRouter(opts);
  const server = Bun.serve({ hostname: '127.0.0.1', port: opts.port ?? 0, idleTimeout: 0, fetch: router.fetch });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}
