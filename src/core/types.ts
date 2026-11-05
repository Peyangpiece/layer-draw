/**
 * ドキュメント／レイヤーのデータモデル（仕様書 8章）。
 * ピクセルデータは持たず、bitmapId で BitmapStore を参照する。
 */
import type { DecomposeParams } from "../decompose/types";

export type BlendMode =
  | "normal"
  | "multiply"
  | "screen"
  | "overlay"
  | "add"
  | "darken"
  | "lighten"
  | "color-dodge"
  | "color-burn"
  | "hard-light"
  | "soft-light"
  | "difference"
  | "exclusion"
  | "hue"
  | "saturation"
  | "color"
  | "luminosity";

export type LayerRole = "normal" | "lineart" | "part" | "background" | "source";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayerBase {
  id: string;
  name: string;
  visible: boolean;
  /** 0..1 */
  opacity: number;
  blendMode: BlendMode;
  /** true: 直下のレイヤーにクリッピング */
  clipping: boolean;
  locked: boolean;
}

export interface RasterLayer extends LayerBase {
  kind: "raster";
  role: LayerRole;
  alphaLocked: boolean;
  isReference: boolean;
  /** BitmapStore 上のピクセルデータの ID */
  bitmapId: string;
  /** ビットマップを配置するドキュメント座標上の矩形（ビットマップの寸法と一致） */
  bounds: Rect;
  part?: { fillColor?: string; sourceLabel?: number };
}

export interface LayerGroup extends LayerBase {
  kind: "group";
  expanded: boolean;
  /** 先頭が最前面 */
  children: LayerNode[];
}

export type LayerNode = RasterLayer | LayerGroup;

/** 1 枚の画像（png/jpeg/svg）と、レイヤー付きのファイル（psd/ora） */
export type SourceFormat = "png" | "jpeg" | "svg" | "psd" | "ora";

export interface SourceImageInfo {
  bitmapId: string;
  format: SourceFormat;
  fileName: string;
  /** 元画像の寸法（SVG の場合はラスタライズ前の論理サイズ） */
  originalWidth: number;
  originalHeight: number;
  /** 直近の自動分解に使ったパラメータ（再分解の初期値） */
  params: DecomposeParams;
  /**
   * レイヤー付きのファイル（PSD / ORA）から開いたか。true のとき bitmapId は全レイヤーを合成した画像で、
   * 「再分解」で全体を置き換えず、選んだレイヤーを分解する
   */
  layered?: boolean;
}

export interface LayerDocument {
  id: string;
  name: string;
  width: number;
  height: number;
  dpi: number;
  root: LayerGroup;
  createdAt: string;
  updatedAt: string;
  source?: SourceImageInfo;
}
