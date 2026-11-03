/**
 * SVG ルート要素の width / height / viewBox から論理サイズ（px）を決める。
 * DOM に依存しない純粋関数としてテスト可能にしている。
 *
 * 単位換算は CSS の絶対単位定義に従う: 1in = 96px, 1cm = 96/2.54px, 1mm = 1/10cm,
 * 1pt = 1/72in, 1pc = 12pt, 1Q = 1/4mm。
 * em / ex / % などの相対単位は解決できないため null を返し、viewBox にフォールバックする。
 */

const UNIT_TO_PX: Record<string, number> = {
  "": 1,
  px: 1,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 25.4 / 4,
  pt: 96 / 72,
  pc: 16,
};

export function parseLength(value: string | null | undefined): number | null {
  if (value == null) return null;
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([a-z%]*)\s*$/i.exec(value);
  if (!m) return null;
  const num = Number(m[1]);
  const factor = UNIT_TO_PX[m[2]!.toLowerCase()];
  if (factor === undefined || !Number.isFinite(num) || num <= 0) return null;
  return num * factor;
}

export interface ViewBox {
  minX: number;
  minY: number;
  width: number;
  height: number;
}

export function parseViewBox(value: string | null | undefined): ViewBox | null {
  if (value == null) return null;
  const parts = value.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [minX, minY, width, height] = parts as [number, number, number, number];
  if (width <= 0 || height <= 0) return null;
  return { minX, minY, width, height };
}

export interface SvgSizeResult {
  width: number;
  height: number;
  /** どの情報から決まったか（UI 表示・デバッグ用） */
  from: "attributes" | "viewBox" | "mixed" | "default";
}

/** サイズ情報が一切ない SVG の既定サイズ（ブラウザの置換要素の既定 300×150 に合わせる） */
export const DEFAULT_SVG_SIZE = { width: 300, height: 150 } as const;

export function resolveSvgSize(attrs: {
  width?: string | null;
  height?: string | null;
  viewBox?: string | null;
}): SvgSizeResult {
  const w = parseLength(attrs.width);
  const h = parseLength(attrs.height);
  const vb = parseViewBox(attrs.viewBox);

  if (w != null && h != null) return { width: w, height: h, from: "attributes" };
  if (vb) {
    const ratio = vb.height / vb.width;
    if (w != null) return { width: w, height: w * ratio, from: "mixed" };
    if (h != null) return { width: h / ratio, height: h, from: "mixed" };
    return { width: vb.width, height: vb.height, from: "viewBox" };
  }
  if (w != null) return { width: w, height: DEFAULT_SVG_SIZE.height, from: "mixed" };
  if (h != null) return { width: DEFAULT_SVG_SIZE.width, height: h, from: "mixed" };
  return { ...DEFAULT_SVG_SIZE, from: "default" };
}

/** 長辺を targetLongSide に合わせた整数ラスタサイズを返す（縦横比維持、最小 1px） */
export function fitLongSide(width: number, height: number, targetLongSide: number): { width: number; height: number } {
  const scale = targetLongSide / Math.max(width, height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
