/**
 * 自動分解パイプライン本体（仕様書 5.1）。Worker からもテストからも呼べるよう DOM 非依存。
 *
 * 実装状況:
 *   [済] 1. 線画抽出（L-1 明度→アルファ）
 *   [未] 2. 領域分割（二値マスク・隙間閉じ・ラベリング・色クラスタリング）
 *   [未] 3. パーツ統合・ノイズ除去
 *   [未] 4. 線下補完
 *   [未] 5. パーツのレイヤー化
 * 未実装ステージは空の結果を返し、パイプラインの骨格だけを通す。
 */
import { extractLineart } from "./lineart";
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
    timings[stage] = performance.now() - t0;
    onProgress(stage, 1);
    return r;
  };

  const lineart = run("lineart", () => extractLineart(image, params.lineart));
  // TODO(Phase 0): 領域分割・統合・線下補完・レイヤー化を実装する
  const parts = run("segment", () => []);

  return { lineart, parts, timings };
}
