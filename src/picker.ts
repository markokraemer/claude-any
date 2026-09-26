import { type Config, allModelIds } from './config';
import { formatCost, formatTokens, type ModelInfo, readModelCache } from './models';

export interface PickerOption {
  model: string;
  label: string;
  description: string;
}

export function modelInfo(config: Config, cache: Record<string, ModelInfo[]>, id: string): ModelInfo | undefined {
  const slash = id.indexOf('/');
  const provider = id.slice(0, slash);
  const model = id.slice(slash + 1);
  return config.providers[provider] ? cache[provider]?.find((m) => m.id === model) : undefined;
}

export function loadCaches(config: Config): Record<string, ModelInfo[]> {
  return Object.fromEntries(Object.keys(config.providers).map((name) => [name, readModelCache(name)]));
}

// One /model row per configured model, in config order:
//   Kimi K3 2.8T
//   kortix · 1M context · $2.5/$14 per MTok
export function pickerOptions(config: Config, cache: Record<string, ModelInfo[]>): PickerOption[] {
  return allModelIds(config).map((id) => {
    const slash = id.indexOf('/');
    const provider = id.slice(0, slash);
    const model = id.slice(slash + 1);
    const info = modelInfo(config, cache, id);
    const label = config.providers[provider]?.labels?.[model] ?? info?.name ?? model;
    const context = formatTokens(info?.contextTokens);
    const description = [provider, context && `${context} context`, formatCost(info)].filter(Boolean).join(' · ');
    return { model: id, label, description };
  });
}

// The context window Claude Code assumes for every routed id. It cannot be
// set per model, so the default is the smallest known window: compacting a
// large-window model early is safe, overflowing a small one is not.
export function contextWindow(config: Config, cache: Record<string, ModelInfo[]>): number | undefined {
  if (config.maxContextTokens) return config.maxContextTokens;
  const windows = allModelIds(config)
    .map((id) => modelInfo(config, cache, id)?.contextTokens)
    .filter((n): n is number => typeof n === 'number' && n > 0);
  return windows.length ? Math.min(...windows) : undefined;
}

export function buildSettings(config: Config, cache: Record<string, ModelInfo[]>): Record<string, unknown> {
  return {
    modelPicker: {
      replaceBuiltInOptions: true,
      options: pickerOptions(config, cache),
    },
  };
}
