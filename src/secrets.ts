import { spawnSync } from 'node:child_process';

const SERVICE = 'claude-any';

export const keychainAvailable = (): boolean => process.platform === 'darwin';

export function keychainSet(account: string, secret: string): void {
  // -U updates an existing item instead of failing on a duplicate.
  const res = spawnSync('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', account, '-w', secret], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  if (res.status !== 0) throw new Error(`Keychain write failed: ${res.stderr.toString().trim()}`);
}

export function keychainGet(account: string): string | null {
  const res = spawnSync('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w'], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return res.status === 0 ? res.stdout.toString().trim() : null;
}

export function keychainDelete(account: string): void {
  spawnSync('security', ['delete-generic-password', '-s', SERVICE, '-a', account], { stdio: 'ignore' });
}

// Resolve a provider's `apiKey` reference to the key itself.
export function resolveKey(provider: string, ref: string): string {
  if (ref === 'keychain') {
    const key = keychainGet(provider);
    if (!key) throw new Error(`No key for "${provider}" in the Keychain. Run: claude-any key ${provider}`);
    return key;
  }
  if (ref.startsWith('env:')) {
    const name = ref.slice(4);
    const key = process.env[name];
    if (!key) throw new Error(`Provider "${provider}" reads its key from $${name}, which is not set.`);
    return key;
  }
  return ref;
}
