export interface Key {
  pk: string;
  sk: string;
}
export interface Entry<T = any> extends Key {
  version: number;
  value: T;
}
export interface Check extends Key {
  version: number | null;
}
export interface Write extends Check {
  value: unknown;
}
export class Conflict extends Error {}
export interface TransactionStore {
  get<T = any>(key: Key): Promise<Entry<T> | null>;
  query<T = any>(pk: string, prefix: string): Promise<Entry<T>[]>;
  transact(writes: Write[], checks?: Check[]): Promise<void>;
}
