// The ChatGPT login that `codex login` writes to ~/.codex/auth.json.
//
// Tokens refresh through auth.openai.com and are written back to the same
// file in the same shape, so the Codex CLI keeps working with the rotated
// refresh token. A refresh token works once: the file is re-read right before
// a refresh in case the Codex CLI refreshed first.

import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const AUTH_BASE = 'https://auth.openai.com';
// The Codex CLI's public OAuth client.
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const REFRESH_WINDOW_MS = 5 * 60 * 1000;

export const codexAuthPath = (): string =>
  join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json');

interface CodexAuthFile {
  tokens?: { id_token?: string; access_token?: string; refresh_token?: string; account_id?: string };
  last_refresh?: string;
  [key: string]: unknown;
}

export interface CodexCredential {
  access: string;
  accountId?: string;
}

function jwtExpiryMs(jwt: string | undefined): number | undefined {
  const payload = jwt?.split('.')[1];
  if (!payload) return undefined;
  try {
    const exp = (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: number }).exp;
    return typeof exp === 'number' ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function readAuthFile(): CodexAuthFile {
  const path = codexAuthPath();
  if (!existsSync(path)) throw new Error(`No ChatGPT login at ${path}. Run: codex login`);
  return JSON.parse(readFileSync(path, 'utf8')) as CodexAuthFile;
}

// Same file, same shape the Codex CLI writes, so `codex` keeps working with
// the rotated refresh token.
function writeAuthFile(auth: CodexAuthFile): void {
  const path = codexAuthPath();
  const tmp = `${path}.claude-any-${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(auth, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

let inflightRefresh: Promise<CodexCredential> | null = null;

async function refresh(fetchImpl: typeof fetch, rejectedAccess?: string): Promise<CodexCredential> {
  // Re-read first: the Codex CLI may have refreshed since our last read, and
  // a refresh token works only once.
  const auth = readAuthFile();
  const current = auth.tokens ?? {};
  const exp = jwtExpiryMs(current.access_token);
  if (current.access_token && current.access_token !== rejectedAccess && exp && exp - Date.now() > REFRESH_WINDOW_MS) {
    return { access: current.access_token, accountId: current.account_id };
  }
  if (!current.refresh_token) throw new Error('ChatGPT login has no refresh token. Run: codex login');
  const res = await fetchImpl(`${AUTH_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: current.refresh_token }),
  });
  if (!res.ok) throw new Error(`ChatGPT token refresh failed (${res.status}). Run: codex login`);
  const tokens = (await res.json()) as { access_token?: string; refresh_token?: string; id_token?: string };
  if (!tokens.access_token) throw new Error('ChatGPT token refresh returned no access token. Run: codex login');
  auth.tokens = {
    ...current,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? current.refresh_token,
    id_token: tokens.id_token ?? current.id_token,
  };
  auth.last_refresh = new Date().toISOString();
  writeAuthFile(auth);
  return { access: tokens.access_token, accountId: current.account_id };
}

/**
 * The current access token, refreshed when it expires within five minutes.
 * `rejectedAccess`: a token the backend just refused with 401; forces a new one.
 */
export async function codexCredential(fetchImpl: typeof fetch = fetch, rejectedAccess?: string): Promise<CodexCredential> {
  const tokens = readAuthFile().tokens ?? {};
  const exp = jwtExpiryMs(tokens.access_token);
  const fresh = tokens.access_token && (!exp || exp - Date.now() > REFRESH_WINDOW_MS);
  if (fresh && tokens.access_token !== rejectedAccess) {
    return { access: tokens.access_token!, accountId: tokens.account_id };
  }
  inflightRefresh ??= refresh(fetchImpl, rejectedAccess).finally(() => {
    inflightRefresh = null;
  });
  return inflightRefresh;
}

export function codexHeaders(credential: CodexCredential): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${credential.access}`,
    originator: 'codex_cli_rs',
    'OpenAI-Beta': 'responses=experimental',
    'content-type': 'application/json',
  };
  if (credential.accountId) headers['chatgpt-account-id'] = credential.accountId;
  return headers;
}

