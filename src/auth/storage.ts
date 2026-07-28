import { AsyncEntry } from '@napi-rs/keyring';
import type { StorageAdapter } from '@tidal-music/auth';

const KEYRING_SERVICE = 'Tidekeeper';

export class KeyringStorageAdapter implements StorageAdapter {
  async load(key: string): Promise<string | null> {
    return (await this.entry(key).getPassword()) ?? null;
  }

  async remove(key: string): Promise<void> {
    await this.entry(key).deleteCredential();
  }

  async save(key: string, value: string): Promise<void> {
    await this.entry(key).setPassword(value);
  }

  private entry(key: string): AsyncEntry {
    return new AsyncEntry(KEYRING_SERVICE, key);
  }
}

export class MemoryStorageAdapter implements StorageAdapter {
  readonly #values = new Map<string, string>();

  load(key: string): Promise<string | null> {
    return Promise.resolve(this.#values.get(key) ?? null);
  }

  remove(key: string): Promise<void> {
    this.#values.delete(key);
    return Promise.resolve();
  }

  save(key: string, value: string): Promise<void> {
    this.#values.set(key, value);
    return Promise.resolve();
  }
}
