/**
 * Vitest global test setup.
 *
 * `fake-indexeddb/auto` registers the full set of IndexedDB globals
 * (IDBFactory, IDBRequest, IDBDatabase, IDBTransaction, …) so that `idb` and
 * any code that references those constructors works in Node.js.
 *
 * Then, before each test, we swap in a brand-new IDBFactory instance so every
 * test starts with a completely empty in-memory database — the same isolation
 * guarantee the previous localforage MemStore mock provided.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach } from "vitest";

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});
