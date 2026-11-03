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

/**
 * 線画抽出の方式（仕様書 5.2）:
 *  - lightness: L-1。明度が低いほど線とみなす（白い紙に黒線向け）
 *  - tophat   : L-3。周囲より暗く、かつ maxLineWidth より細い構造を線とみなす
 *               （明度のクロージングとの差＝ブラックトップハットを、局所背景の明度で割った相対値）。塗りのある画像（区分 B）や
 *               照明ムラのある撮影画像にも対応する。白背景では lightness と同じ結果になる
 */
export type LineartMethod = "lightness" | "tophat";

export interface LineartParams {
  method: LineartMethod;
  /** tophat のみ: これより太い暗い領域は線ではなく塗りとみなす（px） */
  maxLineWidth: number;
  /** これ以下の明度（0..1。L* を 100 で割った値）を完全な線（アルファ 1）とする */
  blackLevel: number;
  /** これ以上の明度を完全な背景（アルファ 0）とする */
  whiteLevel: number;
  /** 線の色: 黒固定 / 元画像の色を保持 */
  lineColor: "black" | "original";
}

/**
 * パーツの塗り色:
 *  - auto   : すべてのパーツが白っぽい（線画のみの入力）なら palette、そうでなければ source
 *  - source : 元画像の領域内平均色
 *  - palette: 隣接パーツで色相が離れる自動配色
 *  - white  : 白
 */
export type FillMode = "auto" | "source" | "palette" | "white";

export interface SegmentParams {
  /** 線画アルファがこれ以上（0..1）の画素を「線」とみなす */
  lineThreshold: number;
  /** 隙間閉じの半径（px）。幅 2*gapRadius px 以下の線の途切れを閉じる。0 で無効 */
  gapRadius: number;
  /** 総画素数に対するこの割合未満の領域を隣接パーツに吸収する */
  minAreaRatio: number;
  /** パーツ数の上限（背景を除く） */
  maxParts: number;
  /**
   * 隣り合う画素の色差（sRGB のユークリッド距離, 0..441）がこれ以下なら同じ領域としてつなぐ。
   * 線で仕切られていない色の境界（例: 黒ベタと白）で領域を分けるため。大きくすると色で分けなくなる
   */
  colorTolerance: number;
  /** 画像の外周に接する領域を背景とみなし、パーツにしない */
  borderAsBackground: boolean;
  fill: FillMode;
}

export interface DecomposeParams {
  lineart: LineartParams;
  segment: SegmentParams;
}

export const DEFAULT_DECOMPOSE_PARAMS: DecomposeParams = {
  lineart: { method: "tophat", maxLineWidth: 16, blackLevel: 0.2, whiteLevel: 0.9, lineColor: "black" },
  segment: {
    lineThreshold: 0.5,
    gapRadius: 2,
    minAreaRatio: 0.0001,
    maxParts: 64,
    colorTolerance: 40,
    borderAsBackground: true,
    fill: "auto",
  },
};

export interface DecomposedPart {
  label: number;
  name: string;
  /** パーツの代表色 #rrggbb */
  fillColor: string;
  /** 線の下の補完分を含む面積（px） */
  area: number;
  /** ドキュメント座標での外接矩形と、その範囲のビットマップ */
  x: number;
  y: number;
  image: RasterImage;
}

export interface DecomposeResult {
  lineart: RasterImage;
  parts: DecomposedPart[];
  /** auto を解決した後の実際の塗り方 */
  resolvedFill: Exclude<FillMode, "auto">;
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
