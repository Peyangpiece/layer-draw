/**
 * キャンバス表示の座標変換（拡大・縮小・回転・移動）。DOM 非依存の純粋関数。
 *
 *   画面座標 = 平行移動 t + 回転 R(rotation) · 倍率 scale · ドキュメント座標
 *
 * 画面座標はビューポート要素の左上を原点とする CSS px。回転はラジアン（時計回りが正、CSS と同じ）。
 */

export interface ViewTransform {
  scale: number;
  rotation: number;
  tx: number;
  ty: number;
}

export interface Pt {
  x: number;
  y: number;
}

export const MIN_SCALE = 0.02;
export const MAX_SCALE = 32;

/** 拡大・縮小ボタン / ショートカットの段階（%） */
export const ZOOM_PRESETS = [
  2, 3, 4, 6.25, 8.33, 12.5, 16.67, 25, 33.33, 50, 66.67, 100, 150, 200, 300, 400, 600, 800, 1200, 1600, 2400, 3200,
].map((p) => p / 100);

export const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

export function docToScreen(v: ViewTransform, p: Pt): Pt {
  const c = Math.cos(v.rotation), s = Math.sin(v.rotation);
  return { x: v.tx + v.scale * (c * p.x - s * p.y), y: v.ty + v.scale * (s * p.x + c * p.y) };
}

export function screenToDoc(v: ViewTransform, p: Pt): Pt {
  const c = Math.cos(v.rotation), s = Math.sin(v.rotation);
  const dx = (p.x - v.tx) / v.scale, dy = (p.y - v.ty) / v.scale;
  // 回転の逆変換（転置）
  return { x: c * dx + s * dy, y: -s * dx + c * dy };
}

/** ドキュメント点 doc が画面点 screen に来るように平行移動を決める */
function anchor(scale: number, rotation: number, doc: Pt, screen: Pt): ViewTransform {
  const c = Math.cos(rotation), s = Math.sin(rotation);
  return { scale, rotation, tx: screen.x - scale * (c * doc.x - s * doc.y), ty: screen.y - scale * (s * doc.x + c * doc.y) };
}

/** 画面点 at を中心に倍率を newScale にする（at の下のドキュメント点は動かない） */
export function zoomTo(v: ViewTransform, newScale: number, at: Pt): ViewTransform {
  return anchor(clampScale(newScale), v.rotation, screenToDoc(v, at), at);
}

export function panBy(v: ViewTransform, dx: number, dy: number): ViewTransform {
  return { ...v, tx: v.tx + dx, ty: v.ty + dy };
}

/** 現在の倍率より一段大きい / 小さいプリセット */
export function nextPreset(scale: number, dir: 1 | -1): number {
  const eps = 1e-6;
  if (dir > 0) return ZOOM_PRESETS.find((p) => p > scale + eps) ?? MAX_SCALE;
  return [...ZOOM_PRESETS].reverse().find((p) => p < scale - eps) ?? MIN_SCALE;
}

/**
 * ドキュメント全体がビューポートに収まる表示（回転は維持）。
 * 回転したドキュメントの外接矩形がビューポートの (1 - 2*marginRatio) に収まる倍率で中央に置く。
 */
export function fitView(docW: number, docH: number, viewW: number, viewH: number, rotation = 0, margin = 24): ViewTransform {
  const c = Math.abs(Math.cos(rotation)), s = Math.abs(Math.sin(rotation));
  const bw = docW * c + docH * s, bh = docW * s + docH * c;
  const scale = clampScale(Math.min((viewW - 2 * margin) / bw, (viewH - 2 * margin) / bh));
  return anchor(scale, rotation, { x: docW / 2, y: docH / 2 }, { x: viewW / 2, y: viewH / 2 });
}

/** 倍率は維持して、ドキュメント中心をビューポート中心に置く（100% 表示などで使う） */
export function centerAt(docW: number, docH: number, viewW: number, viewH: number, scale: number, rotation: number): ViewTransform {
  return anchor(clampScale(scale), rotation, { x: docW / 2, y: docH / 2 }, { x: viewW / 2, y: viewH / 2 });
}

/** ビューポート中心を軸に回転角を設定する */
export function rotateTo(v: ViewTransform, rotation: number, center: Pt): ViewTransform {
  return anchor(v.scale, rotation, screenToDoc(v, center), center);
}

/**
 * 2 本指ジェスチャー: 開始時の 2 点 (p1, p2) が現在 (q1, q2) に動いたときの表示。
 * 開始時の中点の下にあったドキュメント点が、現在の中点に来るようにする（拡大・回転・移動を同時に扱う）。
 */
export function pinch(start: ViewTransform, p1: Pt, p2: Pt, q1: Pt, q2: Pt, allowRotate = true): ViewTransform {
  const d0 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const d1 = Math.hypot(q2.x - q1.x, q2.y - q1.y);
  const k = d0 > 0 ? d1 / d0 : 1;
  const a0 = Math.atan2(p2.y - p1.y, p2.x - p1.x);
  const a1 = Math.atan2(q2.y - q1.y, q2.x - q1.x);
  const midP = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  const midQ = { x: (q1.x + q2.x) / 2, y: (q1.y + q2.y) / 2 };
  const rotation = allowRotate ? normalizeAngle(start.rotation + (a1 - a0)) : start.rotation;
  return anchor(clampScale(start.scale * k), rotation, screenToDoc(start, midP), midQ);
}

/** -π..π に正規化 */
export function normalizeAngle(a: number): number {
  const t = ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  return t - Math.PI;
}

/** 0°/90°/180°/270° から tolerance（ラジアン）以内なら吸着させた角度を返す */
export function snapRotation(a: number, tolerance = (5 * Math.PI) / 180): number {
  const q = Math.PI / 2;
  const nearest = Math.round(a / q) * q;
  return Math.abs(a - nearest) <= tolerance ? normalizeAngle(nearest) : a;
}

/** CSS transform 文字列（transform-origin: 0 0 前提） */
export function cssTransform(v: ViewTransform): string {
  const c = Math.cos(v.rotation) * v.scale, s = Math.sin(v.rotation) * v.scale;
  return `matrix(${c}, ${s}, ${-s}, ${c}, ${v.tx}, ${v.ty})`;
}

/** 表示用の角度（度, -180..180, 小数第 1 位で丸め） */
export function rotationDegrees(v: ViewTransform): number {
  return Math.round((v.rotation * 180) / Math.PI * 10) / 10;
}
