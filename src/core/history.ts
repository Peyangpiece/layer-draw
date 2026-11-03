/**
 * スナップショット方式の取り消し/やり直し。
 * ドキュメントはイミュータブルで、ピクセルデータは bitmapId 参照のため、
 * スナップショットはツリー構造分のメモリしか消費しない。
 * （ピクセル編集時は新しい bitmapId を発行する前提。古いビットマップの解放は BitmapStore.gc で行う。）
 *
 * スライダー操作のような連続変更は replace() で現在値だけを書き換え、
 * 操作終了時に commit() で「操作開始前の値」を 1 ステップとして履歴に積む。
 */
export interface History<T> {
  past: T[];
  present: T;
  future: T[];
  limit: number;
  /** replace() 開始前の値。未確定の連続変更が無ければ undefined */
  pending?: T;
}

export function createHistory<T>(present: T, limit = 50): History<T> {
  return { past: [], present, future: [], limit };
}

function pushRaw<T>(h: History<T>, prev: T, next: T): History<T> {
  const past = [...h.past, prev];
  if (past.length > h.limit) past.splice(0, past.length - h.limit);
  return { past, present: next, future: [], limit: h.limit };
}

/** 未確定の連続変更を 1 ステップとして確定する */
export function commit<T>(h: History<T>): History<T> {
  if (h.pending === undefined) return h;
  if (h.pending === h.present) return { ...h, pending: undefined };
  return pushRaw(h, h.pending, h.present);
}

export function push<T>(h: History<T>, next: T): History<T> {
  const c = commit(h);
  if (next === c.present) return c;
  return pushRaw(c, c.present, next);
}

export function replace<T>(h: History<T>, next: T): History<T> {
  return { ...h, present: next, pending: h.pending === undefined ? h.present : h.pending };
}

export function undo<T>(h: History<T>): History<T> {
  const c = commit(h);
  const prev = c.past[c.past.length - 1];
  if (prev === undefined) return c;
  return { ...c, past: c.past.slice(0, -1), present: prev, future: [c.present, ...c.future] };
}

export function redo<T>(h: History<T>): History<T> {
  const c = commit(h);
  const [next, ...rest] = c.future;
  if (next === undefined) return c;
  return { ...c, past: [...c.past, c.present], present: next, future: rest };
}

export function canUndo<T>(h: History<T>): boolean {
  return h.past.length > 0 || (h.pending !== undefined && h.pending !== h.present);
}

export function canRedo<T>(h: History<T>): boolean {
  return h.future.length > 0;
}
