/**
 * 自動分解パイプライン（仕様書 5 章）の型定義。
 * Worker 間で受け渡すため、ImageData ではなく構造化複製可能なプレーンオブジェクトを使う。
 */

export interface RasterImage {
  width: number;
  height: number;
  /** RGBA 8bit、非乗算アルファ（ImageData と同じ並び） */
  data: Uint8ClampedArray;
}

export interface LineartParams {
  /** これ以下の明度（0..1。L* を 100 で割った値）を完全な線（アルファ 1）とする */
  blackLevel: number;
  /** これ以上の明度を完全な背景（アルファ 0）とする */
  whiteLevel: number;
  /** 線の色: 黒固定 / 元画像の色を保持 */
  lineColor: "black" | "original";
}

export interface DecomposeParams {
  lineart: LineartParams;
  // 以降のステージ（領域分割・隙間閉じ・ノイズ除去・線下補完）のパラメータは Phase 0 で追加する
}

export const DEFAULT_DECOMPOSE_PARAMS: DecomposeParams = {
  lineart: { blackLevel: 0.2, whiteLevel: 0.9, lineColor: "black" },
};

export interface DecomposedPart {
  label: number;
  name: string;
  /** パーツの代表色 #rrggbb */
  fillColor: string;
  /** ドキュメント座標での外接矩形と、その範囲のビットマップ */
  x: number;
  y: number;
  image: RasterImage;
}

export interface DecomposeResult {
  lineart: RasterImage;
  parts: DecomposedPart[];
  /** 各ステージの処理時間（ms） */
  timings: Record<string, number>;
}

export type DecomposeStage = "lineart" | "segment" | "merge" | "underfill" | "layers";

/** Worker とのメッセージ */
export type WorkerRequest = { type: "decompose"; jobId: number; image: RasterImage; params: DecomposeParams };

export type WorkerResponse =
  | { type: "progress"; jobId: number; stage: DecomposeStage; ratio: number }
  | { type: "done"; jobId: number; result: DecomposeResult }
  | { type: "error"; jobId: number; message: string };
