/**
 * 自動分解パイプライン本体（仕様書 5.1）。Worker からもテストからも呼べるよう DOM 非依存。
 *
 * 実装状況:
 *   [済] 1. 線画抽出（L-1 明度→アルファ）
 *   [済] 2. 領域分割（二値マスク・隙間閉じ・ラベリング）  ※色クラスタリング（区分 B）は未実装
 *   [済] 3. 線下補完（領域の成長）
 *   [済] 4. パーツ統合・ノイズ除去
 *   [済] 5. パーツのレイヤー化（1 色ベタ塗り）
 * 2〜4 は segment.ts で一括して行う（順序の理由は segment.ts の冒頭コメント参照）。
 */
import { buildParts } from "./layers";
import { estimateLineWidth, extractLineart } from "./lineart";
import { segment } from "./segment";
import type { DecomposeParams, DecomposeResult, DecomposeStage, RasterImage } from "./types";

export type ProgressFn = (stage: DecomposeStage, ratio: number) => void;

export interface CancelToken {
  readonly cancelled: boolean;
}

export class CancelledError extends Error {
  constructor() {
    super("cancelled");
  }
}

export function decompose(
  image: RasterImage,
  params: DecomposeParams,
  onProgress: ProgressFn = () => {},
  cancel: CancelToken = { cancelled: false },
): DecomposeResult {
  const timings: Record<string, number> = {};
  const run = <T>(stage: DecomposeStage, fn: () => T): T => {
    if (cancel.cancelled) throw new CancelledError();
    onProgress(stage, 0);
    const t0 = performance.now();
    const r = fn();
    timings[stage] = (timings[stage] ?? 0) + performance.now() - t0; // 同じ段階を複数回呼ぶ場合は合算
    onProgress(stage, 1);
    return r;
  };

  // 線とみなす最大の太さ: 自動なら画像の線の太さから決める（推定できなければ手動の値）
  const lineWidth = run("lineart", () => {
    const auto = params.lineart.method === "tophat" && params.lineart.autoLineWidth;
    const est = auto ? estimateLineWidth(image) : null;
    return { auto, estimated: est ? est.width : null, used: est ? est.maxLineWidth : params.lineart.maxLineWidth };
  });
  const lineart = run("lineart", () => extractLineart(image, { ...params.lineart, maxLineWidth: lineWidth.used }));
  const seg = run("segment", () => segment(lineart, image, params.segment));
  const { parts, resolvedFill } = run("layers", () => buildParts(seg, params.segment.fill));

  return { lineart, parts, resolvedFill, lineWidth, timings };
}
