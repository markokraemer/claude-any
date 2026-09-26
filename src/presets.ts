import type { AuthHeader } from './config';

export interface Preset {
  baseUrl: string;
  authHeader: AuthHeader;
  forwardBetas: boolean;
  // Where to get a key, shown by `claude-any add`.
  keyHint: string;
}

// Anthropic-compatible endpoints. The router appends `/v1/messages`.
export const PRESETS: Record<string, Preset> = {
  kortix: {
    baseUrl: 'https://gateway.kortix.com',
    authHeader: 'bearer',
    forwardBetas: false,
    keyHint: 'Kortix project → Customize → Gateway, tab Gateway → create a kortix_gw_ key',
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    authHeader: 'x-api-key',
    forwardBetas: true,
    keyHint: 'console.anthropic.com → API keys',
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api',
    authHeader: 'bearer',
    forwardBetas: false,
    keyHint: 'openrouter.ai/keys',
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com/anthropic',
    authHeader: 'bearer',
    forwardBetas: false,
    keyHint: 'platform.deepseek.com/api_keys',
  },
  moonshot: {
    baseUrl: 'https://api.moonshot.ai/anthropic',
    authHeader: 'bearer',
    forwardBetas: false,
    keyHint: 'platform.moonshot.ai → API keys',
  },
  zai: {
    baseUrl: 'https://api.z.ai/api/anthropic',
    authHeader: 'bearer',
    forwardBetas: false,
    keyHint: 'z.ai → API keys',
  },
  minimax: {
    baseUrl: 'https://api.minimax.io/anthropic',
    authHeader: 'bearer',
    forwardBetas: false,
    keyHint: 'minimax.io → API keys',
  },
};
