/**
 * レイヤー付きファイル（PSD / ORA）を読み込んだ結果。DOM に依存しない中間表現で、
 * ここからエディタのドキュメント（core/types）を組み立てる。
 */
import type { BlendMode } from "../../core/types";
import type { RasterImage } from "../../decompose/types";

export interface ImportedLayerBase {
  name: string;
  visible: boolean;
  /** 0..1 */
  opacity: number;
  blendMode: BlendMode;
  clipping: boolean;
}

export interface ImportedRaster extends ImportedLayerBase {
  kind: "raster";
  /** ドキュメント座標での左上 */
  x: number;
  y: number;
  image: RasterImage;
  /** 透明度保護（PSD のみ） */
  alphaLocked?: boolean;
}

export interface ImportedGroup extends ImportedLayerBase {
  kind: "group";
  expanded: boolean;
  /** 先頭が最前面（エディタと同じ並び） */
  children: ImportedNode[];
}

export type ImportedNode = ImportedRaster | ImportedGroup;

export interface LayeredImport {
  format: "psd" | "ora";
  width: number;
  height: number;
  /** 先頭が最前面 */
  children: ImportedNode[];
  /** 読み込めなかった・反映できなかった要素の説明（同じ内容は 1 つにまとめる） */
  warnings: string[];
}

/** 読み込めない理由（利用者に見せる文） */
export class LayeredImportError extends Error {}

/** 同じ警告をまとめ、件数を付ける */
export class WarningSet {
  private counts = new Map<string, number>();
  add(message: string) {
    this.counts.set(message, (this.counts.get(message) ?? 0) + 1);
  }
  list(): string[] {
    return [...this.counts].map(([m, n]) => (n > 1 ? `${m}（${n} 件）` : m));
  }
}

/** ツリー内のラスタレイヤー数 */
export function countRasters(nodes: ImportedNode[]): number {
  return nodes.reduce((a, n) => a + (n.kind === "raster" ? 1 : countRasters(n.children)), 0);
}
