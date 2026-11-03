/**
 * パーツのタップ選択・分割・結合（仕様書 6.2）を、ドキュメントとビットマップに対する操作として組み立てる。
 * ピクセル処理そのものは core/partOps.ts。
 */
import type { BitmapStore } from "../core/bitmapStore";
import { displayIndex, findNode, visibleRasterLayersFrontToBack } from "../core/document";
import { newId } from "../core/id";
import { mergeParts, opaqueArea, rasterizeStroke, splitPart, type Point } from "../core/partOps";
import type { LayerDocument, RasterLayer } from "../core/types";
import { toImageData } from "./buildFromImport";
import type { EditorAction } from "./editorStore";

/** 分割の切断線の半径（ドキュメント px）。幅 3px の線になり、4 近傍の連結を確実に断つ */
const CUT_RADIUS = 1;

/** 属性を引き継ぎつつ新しい ID を持つレイヤーを作る（取り消し履歴で元のレイヤーと区別するため） */
function cloneLayer(layer: RasterLayer, patch: Partial<RasterLayer>): RasterLayer {
  return { ...layer, part: layer.part ? { ...layer.part } : undefined, ...patch, id: newId("lyr") };
}

export type OpResult = { ok: true; action: EditorAction; message: string } | { ok: false; reason: string };

function alphaAt(layer: RasterLayer, bitmaps: BitmapStore, x: number, y: number): number {
  const img = bitmaps.get(layer.bitmapId);
  if (!img) return 0;
  const lx = Math.floor(x) - layer.bounds.x, ly = Math.floor(y) - layer.bounds.y;
  if (lx < 0 || ly < 0 || lx >= img.width || ly >= img.height) return 0;
  return img.data[(ly * img.width + lx) * 4 + 3]!;
}

/** (x, y) にある最前面の表示中パーツ。パーツは線の下まで塗られているので、線の上をタップしても選べる */
export function hitTestPart(doc: LayerDocument, bitmaps: BitmapStore, x: number, y: number): RasterLayer | undefined {
  return visibleRasterLayersFrontToBack(doc.root).find((l) => l.role === "part" && alphaAt(l, bitmaps, x, y) > 0);
}

/**
 * 分割対象のパーツを決める: 選択中のパーツがあればそれ（複数なら主選択）、
 * なければ切断線の画素を最も多く含む表示中パーツ。
 */
export function pickSplitTarget(doc: LayerDocument, bitmaps: BitmapStore, selectedIds: string[], stroke: Point[]): RasterLayer | undefined {
  for (let i = selectedIds.length - 1; i >= 0; i--) {
    const n = findNode(doc.root, selectedIds[i]!);
    if (n && n.kind === "raster" && n.role === "part") return n;
  }
  let best: RasterLayer | undefined, bestCount = 0;
  for (const layer of visibleRasterLayersFrontToBack(doc.root)) {
    if (layer.role !== "part") continue;
    const img = bitmaps.get(layer.bitmapId);
    if (!img) continue;
    const mask = rasterizeStroke(stroke, layer.bounds, CUT_RADIUS);
    let count = 0;
    for (let p = 0; p < mask.length; p++) if (mask[p] && img.data[p * 4 + 3]! > 0) count++;
    if (count > bestCount) { best = layer; bestCount = count; }
  }
  return best;
}

export function splitLayer(bitmaps: BitmapStore, layer: RasterLayer, stroke: Point[]): OpResult {
  const img = bitmaps.get(layer.bitmapId);
  if (!img) return { ok: false, reason: "パーツの画像が見つかりません。" };
  if (layer.locked) return { ok: false, reason: `「${layer.name}」はロックされています。` };
  const cut = rasterizeStroke(stroke, layer.bounds, CUT_RADIUS);
  const result = splitPart({ x: layer.bounds.x, y: layer.bounds.y, image: img }, cut);
  if (!result.ok) return result;

  // 最大のピースが元のレイヤーの名前・属性を引き継ぐ
  const nodes = result.pieces.map((piece, i) =>
    cloneLayer(layer, {
      name: i === 0 ? layer.name : `${layer.name}-${i + 1}`,
      bitmapId: bitmaps.add(toImageData(piece.image)),
      bounds: { x: piece.x, y: piece.y, w: piece.image.width, h: piece.image.height },
    }),
  );
  return {
    ok: true,
    // 分割されて新しくできた側（2 番目以降）を選択し、どこが切り離されたか分かるようにする
    action: { type: "replaceNode", id: layer.id, nodes, select: nodes.slice(1).map((n) => n.id) },
    message: `「${layer.name}」を ${nodes.length} つに分割しました。`,
  };
}

export function mergeSelected(doc: LayerDocument, bitmaps: BitmapStore, selectedIds: string[]): OpResult {
  const layers = selectedIds
    .map((id) => findNode(doc.root, id))
    .filter((n): n is RasterLayer => !!n && n.kind === "raster" && n.role === "part");
  if (layers.length < 2) return { ok: false, reason: "結合するパーツを 2 つ以上選択してください。" };
  const locked = layers.find((l) => l.locked);
  if (locked) return { ok: false, reason: `「${locked.name}」はロックされています。` };

  // 表示順（前面が先）に並べる
  layers.sort((a, b) => displayIndex(doc.root, a.id) - displayIndex(doc.root, b.id));
  const placed = layers.map((l) => {
    const image = bitmaps.get(l.bitmapId);
    if (!image) throw new Error(`ビットマップが見つかりません: ${l.name}`);
    return { layer: l, x: l.bounds.x, y: l.bounds.y, image, area: opaqueArea(image) };
  });
  // 色と名前は面積が最大のパーツから引き継ぐ
  const largest = placed.reduce((a, b) => (b.area > a.area ? b : a));
  const merged = mergeParts(placed, largest.layer.part?.fillColor);
  const front = layers[0]!;
  const node = cloneLayer(largest.layer, {
    bitmapId: bitmaps.add(toImageData(merged.image)),
    bounds: { x: merged.x, y: merged.y, w: merged.image.width, h: merged.image.height },
  });
  return {
    ok: true,
    action: { type: "mergeNodes", ids: layers.map((l) => l.id), merged: node, insertAt: front.id },
    message: `${layers.length} つのパーツを「${node.name}」に結合しました。`,
  };
}
