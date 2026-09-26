import { appendFileSync } from 'node:fs';

import { type Config, parseModelRef } from './config';
import { anthropicError, type Provider } from './providers/types';

export interface RouterOptions {
  config: Config;
  // One provider per configured upstream, by provider name.
  providers: Record<string, Provider>;
  // Shared secret Claude Code must present. Keeps other local processes from
  // spending the upstream credentials through the open port.
  token: string;
  logFile?: string;
}

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
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await req.text()) as Record<string, unknown>;
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
    const provider = opts.providers[ref.provider];
    if (!provider) return anthropicError(500, 'api_error', `claude-any: provider "${ref.provider}" is not loaded`);
    body.model = ref.model;
    const sentBytes = JSON.stringify(body).length;

    const started = Date.now();
    let res: Response;
    try {
      res = await provider.forward({ path: url.pathname, search: url.search, body, headers: req.headers, signal: req.signal });
    } catch (err) {
      if (req.signal.aborted) return new Response(null, { status: 499 });
      log(`${url.pathname} ${requested} -> ${ref.provider}/${ref.model} network error ${(err as Error).message}`);
      return anthropicError(502, 'api_error', `claude-any: ${ref.provider} unreachable: ${(err as Error).message}`);
    }
    log(`${url.pathname} ${requested} -> ${ref.provider}/${ref.model} ${res.status} ${Date.now() - started}ms`);

    if (!res.ok || config.estimateMissingUsage === false || url.pathname.endsWith('/count_tokens')) return res;
    const estimate = estimateTokens(sentBytes);
    const contentType = res.headers.get('content-type') ?? '';
    if (res.body && contentType.includes('text/event-stream')) {
      return new Response(patchStreamUsage(res.body, estimate), { status: res.status, headers: res.headers });
    }
    if (contentType.includes('application/json')) {
      const json = (await res.json()) as Record<string, unknown>;
      const usage = json.usage as Record<string, unknown> | undefined;
      if (usage && !hasInputUsage(usage)) json.usage = { ...usage, input_tokens: estimate };
      return new Response(JSON.stringify(json), { status: res.status, headers: res.headers });
    }
    return res;
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
