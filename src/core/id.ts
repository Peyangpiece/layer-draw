let counter = 0;

/** ドキュメント内で一意な ID を生成する。crypto.randomUUID が無い環境ではカウンタで代替。 */
export function newId(prefix = "id"): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return `${prefix}_${c.randomUUID()}`;
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter}`;
}
