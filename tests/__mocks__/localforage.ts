/**
 * In-memory localforage stub so tests never touch IndexedDB.
 * createInstance() returns a fresh Map-backed store each time.
 */

class MemStore {
  private store = new Map<string, any>();

  async getItem<T>(key: string): Promise<T | null> {
    return (this.store.get(key) as T) ?? null;
  }

  async setItem<T>(key: string, value: T): Promise<T> {
    this.store.set(key, value);
    return value;
  }

  async removeItem(key: string): Promise<void> {
    this.store.delete(key);
  }

  async clear(): Promise<void> {
    this.store.clear();
  }

  async iterate<T, U>(fn: (value: T, key: string, n: number) => U): Promise<U | undefined> {
    let i = 0;
    let result: U | undefined;
    for (const [k, v] of this.store.entries()) {
      result = fn(v as T, k, i++);
    }
    return result;
  }
}

const localforage = {
  createInstance(_opts: any): MemStore {
    return new MemStore();
  },
};

export default localforage;
