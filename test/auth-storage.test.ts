import { describe, expect, it } from 'vitest';

import { MemoryStorageAdapter } from '../src/auth/storage.js';

describe('memory credential storage', () => {
  it('retains credentials only in the owning process instance', async () => {
    const storage = new MemoryStorageAdapter();

    await storage.save('session', 'secret');

    await expect(storage.load('session')).resolves.toBe('secret');
    await storage.remove('session');
    await expect(storage.load('session')).resolves.toBeNull();
    await expect(
      new MemoryStorageAdapter().load('session'),
    ).resolves.toBeNull();
  });
});
