// Anthropic Messages ⇄ OpenAI Responses, for the ChatGPT Codex backend.
//
//   Anthropic Messages request ──anthropicToResponses──▶ Responses request
//   Responses SSE ──responsesToAnthropicSse──▶ Anthropic Messages SSE
//
// Reasoning survives across turns: each reasoning item streams out as an
// Anthropic `thinking` block whose signature carries the item's encrypted
// content. Claude Code sends thinking blocks back with the next request, and
// the translator turns them back into reasoning items.

const SIGNATURE_PREFIX = 'codex1:';

type Json = Record<string, unknown>;

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is Json => Boolean(b) && (b as Json).type === 'text')
    .map((b) => String(b.text ?? ''))
    .join('\n\n');
};

function imagePart(block: Json): Json | null {
  const source = (block.source as Json | undefined) ?? {};
  if (source.type === 'base64') {
    return { type: 'input_image', image_url: `data:${source.media_type ?? 'image/png'};base64,${source.data ?? ''}` };
  }
  if (source.type === 'url' && typeof source.url === 'string') return { type: 'input_image', image_url: source.url };
  return null;
}

export function encodeReasoningSignature(item: Json): string {
  const payload = { encrypted_content: item.encrypted_content, summary: item.summary ?? [] };
  return SIGNATURE_PREFIX + Buffer.from(JSON.stringify(payload)).toString('base64');
}

export function decodeReasoningSignature(signature: unknown): Json | null {
  if (typeof signature !== 'string' || !signature.startsWith(SIGNATURE_PREFIX)) return null;
  try {
    const payload = JSON.parse(Buffer.from(signature.slice(SIGNATURE_PREFIX.length), 'base64').toString('utf8')) as Json;
    if (typeof payload.encrypted_content !== 'string') return null;
    return { type: 'reasoning', summary: payload.summary ?? [], encrypted_content: payload.encrypted_content };
  } catch {
    return null;
  }
}

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

function reasoningEffort(body: Json): string {
  const thinking = body.thinking as Json | undefined;
  if (thinking?.type === 'disabled') return 'low';
  const effort = (body.output_config as Json | undefined)?.effort;
  if (typeof effort === 'string' && EFFORTS.has(effort)) return effort;
  if (thinking?.type === 'enabled' && typeof thinking.budget_tokens === 'number') {
    const budget = thinking.budget_tokens;
    return budget <= 4096 ? 'low' : budget <= 16000 ? 'medium' : 'high';
  }
  return 'medium';
}

function sessionKey(body: Json, sessionHeader: string | null): string | undefined {
  if (sessionHeader) return sessionHeader;
  const userId = (body.metadata as Json | undefined)?.user_id;
  if (typeof userId !== 'string') return undefined;
  try {
    const sid = (JSON.parse(userId) as Json).session_id;
    return typeof sid === 'string' ? sid : undefined;
  } catch {
    return undefined;
  }
}

export function anthropicToResponses(body: Json, model: string, sessionHeader: string | null = null): Json {
  const input: Json[] = [];
  const messages = (Array.isArray(body.messages) ? body.messages : []) as Json[];
  // The backend returns an empty stream for a conversation that ends on an
  // assistant turn (a cancelled turn replayed as prefill).
  let end = messages.length;
  while (end > 1 && messages[end - 1]?.role === 'assistant') end--;

  for (const message of messages.slice(0, end)) {
    const content = message.content;
    const blocks: Json[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? (content as Json[]) : [];

    if (message.role === 'assistant') {
      for (const block of blocks) {
        if (block.type === 'text' && block.text) {
          input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: String(block.text) }] });
        } else if (block.type === 'tool_use') {
          input.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) });
        } else if (block.type === 'thinking') {
          const reasoning = decodeReasoningSignature(block.signature);
          if (reasoning) input.push(reasoning);
        }
      }
      continue;
    }

    const role = message.role === 'system' ? 'developer' : 'user';
    const parts: Json[] = [];
    const toolImages: Json[] = [];
    for (const block of blocks) {
      if (block.type === 'text') parts.push({ type: 'input_text', text: String(block.text ?? '') });
      else if (block.type === 'image') {
        const part = imagePart(block);
        if (part) parts.push(part);
      } else if (block.type === 'tool_result') {
        const resultBlocks = Array.isArray(block.content) ? (block.content as Json[]) : [];
        const images = resultBlocks.filter((b) => b.type === 'image').map(imagePart).filter((p): p is Json => p !== null);
        let output = typeof block.content === 'string' ? block.content : textOf(block.content);
        if (images.length) {
          output = `${output ? `${output}\n` : ''}[${images.length} image${images.length === 1 ? '' : 's'} attached in the next message]`;
          toolImages.push({ type: 'input_text', text: `Image from tool result ${String(block.tool_use_id)}:` }, ...images);
        }
        if (block.is_error) output = `Error: ${output}`;
        input.push({ type: 'function_call_output', call_id: block.tool_use_id, output });
      }
    }
    const all = [...toolImages, ...parts];
    if (all.length) input.push({ type: 'message', role, content: all });
  }

  const tools = (Array.isArray(body.tools) ? body.tools : [])
    .filter((t): t is Json => Boolean(t) && typeof (t as Json).name === 'string' && (t as Json).input_schema !== undefined)
    .map((t) => ({ type: 'function', name: t.name, description: t.description ?? '', parameters: t.input_schema, strict: false }));

  const choice = body.tool_choice as Json | undefined;
  let toolChoice: unknown = 'auto';
  if (choice?.type === 'any') toolChoice = 'required';
  else if (choice?.type === 'none') toolChoice = 'none';
  else if (choice?.type === 'tool' && typeof choice.name === 'string') toolChoice = { type: 'function', name: choice.name };

  const out: Json = {
    model,
    instructions: textOf(body.system) || 'You are a helpful assistant.',
    input,
    tools,
    tool_choice: toolChoice,
    parallel_tool_calls: true,
    reasoning: { effort: reasoningEffort(body), summary: 'auto' },
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
  };
  const cacheKey = sessionKey(body, sessionHeader);
  if (cacheKey) out.prompt_cache_key = cacheKey;
  return out;
}

const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function errorType(status: number | undefined, code: unknown): string {
  if (status === 429 || code === 'rate_limit_exceeded' || code === 'usage_limit_reached') return 'rate_limit_error';
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 400 || code === 'context_length_exceeded') return 'invalid_request_error';
  if (status === 503 || code === 'server_is_overloaded') return 'overloaded_error';
  return 'api_error';
}

// Claude Code's reactive compaction matches Anthropic's wording.
function errorMessage(code: unknown, message: string): string {
  return code === 'context_length_exceeded' ? `prompt is too long: ${message}` : message;
}

export function responsesToAnthropicSse(upstream: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let started = false;
  let finished = false;
  let index = -1;
  let open: { kind: 'thinking' | 'text' | 'tool_use'; itemId: string; sawArgs?: boolean; sawSummary?: boolean } | null = null;
  let sawToolCall = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: string, data: unknown) => controller.enqueue(encoder.encode(sse(event, data)));
      const start = (id: string) => {
        if (started) return;
        started = true;
        emit('message_start', {
          type: 'message_start',
          message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
        });
      };
      const close = () => {
        if (!open) return;
        emit('content_block_stop', { type: 'content_block_stop', index });
        open = null;
      };
      const fail = (type: string, message: string) => {
        start(`msg_${Date.now().toString(36)}`);
        close();
        emit('error', { type: 'error', error: { type, message } });
        finished = true;
      };

      const handle = (e: Json) => {
        const type = e.type as string;
        if (type === 'response.created') {
          start(`msg_${String((e.response as Json | undefined)?.id ?? Date.now()).replace(/^resp_/, '')}`);
          return;
        }
        start(`msg_${Date.now().toString(36)}`);
        const item = (e.item as Json | undefined) ?? {};

        if (type === 'response.output_item.added') {
          close();
          if (item.type === 'reasoning') {
            index++;
            open = { kind: 'thinking', itemId: String(item.id ?? '') };
            emit('content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
          } else if (item.type === 'message') {
            index++;
            open = { kind: 'text', itemId: String(item.id ?? '') };
            emit('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
          } else if (item.type === 'function_call') {
            index++;
            sawToolCall = true;
            open = { kind: 'tool_use', itemId: String(item.id ?? '') };
            emit('content_block_start', {
              type: 'content_block_start',
              index,
              content_block: { type: 'tool_use', id: item.call_id, name: item.name, input: {} },
            });
          }
          return;
        }
        if (type === 'response.reasoning_summary_text.delta' && open?.kind === 'thinking') {
          emit('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: String(e.delta ?? '') } });
          open.sawSummary = true;
          return;
        }
        if (type === 'response.reasoning_summary_part.added' && open?.kind === 'thinking' && open.sawSummary) {
          emit('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: '\n\n' } });
          return;
        }
        if (type === 'response.output_text.delta' && open?.kind === 'text') {
          emit('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: String(e.delta ?? '') } });
          return;
        }
        if (type === 'response.function_call_arguments.delta' && open?.kind === 'tool_use') {
          open.sawArgs = true;
          emit('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: String(e.delta ?? '') } });
          return;
        }
        if (type === 'response.output_item.done') {
          if (open?.kind === 'thinking' && item.type === 'reasoning') {
            if (typeof item.encrypted_content === 'string') {
              emit('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: encodeReasoningSignature(item) } });
            }
          } else if (open?.kind === 'tool_use' && item.type === 'function_call' && !open.sawArgs && typeof item.arguments === 'string') {
            emit('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: item.arguments } });
          }
          close();
          return;
        }
        if (type === 'response.completed' || type === 'response.incomplete') {
          close();
          const response = (e.response as Json | undefined) ?? {};
          const usage = (response.usage as Json | undefined) ?? {};
          const input = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
          const cached = typeof (usage.input_tokens_details as Json | undefined)?.cached_tokens === 'number'
            ? ((usage.input_tokens_details as Json).cached_tokens as number)
            : 0;
          const incomplete = (response.incomplete_details as Json | undefined)?.reason;
          const stopReason = incomplete === 'max_output_tokens' ? 'max_tokens' : sawToolCall ? 'tool_use' : 'end_turn';
          emit('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: {
              input_tokens: Math.max(0, input - cached),
              cache_read_input_tokens: cached,
              cache_creation_input_tokens: 0,
              output_tokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
            },
          });
          emit('message_stop', { type: 'message_stop' });
          finished = true;
          return;
        }
        if (type === 'response.failed' || type === 'error') {
          const err = (((e.response as Json | undefined)?.error as Json | undefined) ?? (e.error as Json | undefined) ?? e) as Json;
          fail(errorType(undefined, err.code), errorMessage(err.code, String(err.message ?? 'Codex request failed')));
        }
      };

      const reader = upstream.getReader();
      try {
        while (!finished) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          let end = buffer.indexOf('\n\n');
          while (end >= 0 && !finished) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            end = buffer.indexOf('\n\n');
            const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
            if (!dataLine) continue;
            const data = dataLine.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try {
              handle(JSON.parse(data) as Json);
            } catch {
              // A malformed frame is skipped; the completed event still settles the turn.
            }
          }
        }
        if (!finished) fail('api_error', 'Codex stream ended before the response completed');
      } catch (err) {
        if (!finished) fail('api_error', `Codex stream failed: ${(err as Error).message}`);
      } finally {
        reader.releaseLock();
        controller.close();
      }
    },
  });
}

// Claude Code sends a few side requests without `stream`; assemble the
// translated events into one Messages response for those.
export async function collectAnthropicMessage(stream: ReadableStream<Uint8Array>): Promise<{ status: number; body: Json }> {
  const text = await new Response(stream).text();
  const message: Json = { type: 'message', role: 'assistant', content: [] as Json[] };
  const content = message.content as Json[];
  for (const block of text.split('\n\n')) {
    const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
    if (!dataLine) continue;
    const e = JSON.parse(dataLine.slice(5)) as Json;
    if (e.type === 'error') return { status: 502, body: e };
    if (e.type === 'message_start') Object.assign(message, e.message as Json, { content });
    if (e.type === 'content_block_start') content[e.index as number] = { ...(e.content_block as Json) };
    if (e.type === 'content_block_delta') {
      const target = content[e.index as number]!;
      const delta = e.delta as Json;
      if (delta.type === 'text_delta') target.text = String(target.text ?? '') + String(delta.text);
      if (delta.type === 'thinking_delta') target.thinking = String(target.thinking ?? '') + String(delta.thinking);
      if (delta.type === 'signature_delta') target.signature = delta.signature;
      if (delta.type === 'input_json_delta') target._args = String(target._args ?? '') + String(delta.partial_json);
    }
    if (e.type === 'message_delta') {
      Object.assign(message, e.delta as Json);
      message.usage = e.usage;
    }
  }
  for (const block of content) {
    if (block.type === 'tool_use') {
      try {
        block.input = block._args ? JSON.parse(String(block._args)) : {};
      } catch {
        block.input = {};
      }
      delete block._args;
    }
  }
  return { status: 200, body: message };
}

export async function codexErrorResponse(res: Response): Promise<Response> {
  const raw = await res.text();
  let code: unknown;
  let message = raw.slice(0, 500) || `Codex returned ${res.status}`;
  try {
    const j = JSON.parse(raw) as Json;
    const err = (j.error as Json | undefined) ?? j;
    code = err.code ?? err.type;
    message = String(err.message ?? j.detail ?? message);
  } catch {
    // Non-JSON body; keep the raw text.
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) headers['retry-after'] = retryAfter;
  return new Response(
    JSON.stringify({ type: 'error', error: { type: errorType(res.status, code), message: errorMessage(code, message) } }),
    { status: res.status, headers },
  );
}
