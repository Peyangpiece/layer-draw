/**
 * パーツのタップ選択・分割・結合（仕様書 6.2）を、ドキュメントとビットマップに対する操作として組み立てる。
 * ピクセル処理そのものは core/partOps.ts。
 */
import type { BitmapStore } from "../core/bitmapStore";
import { displayIndex, findNode, visibleRasterLayersFrontToBack } from "../core/document";
import { newId } from "../core/id";
import { mergeParts, movePixels, opaqueArea, rasterizeStroke, splitPart, type Point } from "../core/partOps";
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

/**
 * パーツ移動ブラシの移動先を決める: 選択中のパーツ（複数なら主選択）、無ければなぞり始めた位置の最前面のパーツ。
 */
export function pickMoveTarget(doc: LayerDocument, bitmaps: BitmapStore, selectedIds: string[], start: Point): RasterLayer | undefined {
  for (let i = selectedIds.length - 1; i >= 0; i--) {
    const n = findNode(doc.root, selectedIds[i]!);
    if (n && n.kind === "raster" && n.role === "part") return n;
  }
  return hitTestPart(doc, bitmaps, start.x, start.y);
}

/**
 * パーツ移動ブラシ（仕様書 6.2）: なぞった範囲にある他のパーツの画素を、移動先パーツへ移す。
 * 対象は表示中・ロックされていないパーツのみ。線画・背景・元画像には触れない。
 * 移した画素は移動先の塗り色にする。移動元が空になったらレイヤーを削除する。
 */
export function moveBrush(doc: LayerDocument, bitmaps: BitmapStore, target: RasterLayer, stroke: Point[], radius: number): OpResult {
  if (target.locked) return { ok: false, reason: `移動先「${target.name}」はロックされています。` };
  const targetImg = bitmaps.get(target.bitmapId);
  if (!targetImg) return { ok: false, reason: "移動先のパーツの画像が見つかりません。" };

  // なぞった範囲の外接矩形（ドキュメント内に制限）
  const r = Math.max(0.5, radius);
  const xs = stroke.map((p) => p.x), ys = stroke.map((p) => p.y);
  const x0 = Math.max(0, Math.floor(Math.min(...xs) - r - 1)), y0 = Math.max(0, Math.floor(Math.min(...ys) - r - 1));
  const x1 = Math.min(doc.width, Math.ceil(Math.max(...xs) + r + 2)), y1 = Math.min(doc.height, Math.ceil(Math.max(...ys) + r + 2));
  if (x0 >= x1 || y0 >= y1) return { ok: false, reason: "画像の外をなぞっています。" };
  const rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  const mask = rasterizeStroke(stroke, rect, r);

  // 範囲と重なる、表示中・ロックなしの他のパーツ
  const overlaps = (l: RasterLayer) =>
    l.bounds.x < rect.x + rect.w && l.bounds.x + l.bounds.w > rect.x && l.bounds.y < rect.y + rect.h && l.bounds.y + l.bounds.h > rect.y;
  const sources = visibleRasterLayersFrontToBack(doc.root).filter((l) => l.role === "part" && l.id !== target.id && !l.locked && overlaps(l));
  const srcImgs = sources.map((l) => bitmaps.get(l.bitmapId));
  const usable = sources.filter((_, i) => srcImgs[i]);

  const result = movePixels(
    { x: target.bounds.x, y: target.bounds.y, image: targetImg },
    usable.map((l) => ({ x: l.bounds.x, y: l.bounds.y, image: bitmaps.get(l.bitmapId)! })),
    mask,
    rect,
    target.part?.fillColor,
  );
  if (result.moved === 0) {
    return { ok: false, reason: `「${target.name}」へ移せる画素がありません。隣のパーツの上をなぞってください。` };
  }

  const updates: { id: string; bitmapId: string; bounds: { x: number; y: number; w: number; h: number } }[] = [];
  const remove: string[] = [];
  const t = result.target;
  updates.push({ id: target.id, bitmapId: bitmaps.add(toImageData(t.image)), bounds: { x: t.x, y: t.y, w: t.image.width, h: t.image.height } });
  const touched: string[] = [];
  result.sources.forEach((s, i) => {
    const layer = usable[i]!;
    if (s === undefined) return;
    touched.push(layer.name);
    if (s === null) remove.push(layer.id);
    else updates.push({ id: layer.id, bitmapId: bitmaps.add(toImageData(s.image)), bounds: { x: s.x, y: s.y, w: s.image.width, h: s.image.height } });
  });
  const removedNote = remove.length > 0 ? `（${remove.length} つのパーツが空になったため削除）` : "";
  return {
    ok: true,
    action: { type: "updateLayers", updates, remove, select: [target.id] },
    message: `${touched.join("・")} から「${target.name}」へ ${result.moved.toLocaleString()} px 移しました${removedNote}`,
  };
}
