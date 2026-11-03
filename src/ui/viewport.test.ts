import { describe, expect, it } from "vitest";
import {
  cssTransform, docToScreen, fitView, nextPreset, normalizeAngle, panBy, pinch, rotateTo, screenToDoc, snapRotation, zoomTo,
  type ViewTransform,
} from "./viewport";

const close = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  expect(a.x).toBeCloseTo(b.x, 6);
  expect(a.y).toBeCloseTo(b.y, 6);
};
const V: ViewTransform = { scale: 1.7, rotation: 0.6, tx: 30, ty: -12 };

describe("viewport", () => {
  it("docToScreen と screenToDoc は互いに逆変換（回転あり）", () => {
    for (const p of [{ x: 0, y: 0 }, { x: 123, y: -45 }, { x: 800, y: 600 }]) close(screenToDoc(V, docToScreen(V, p)), p);
  });

  it("cssTransform は docToScreen と同じ写像（matrix(a,b,c,d,e,f) で x' = a x + c y + e）", () => {
    const m = cssTransform(V).match(/matrix\((.+)\)/)![1]!.split(",").map(Number);
    const [a, b, c, d, e, f] = m as [number, number, number, number, number, number];
    const p = { x: 50, y: 70 };
    close({ x: a * p.x + c * p.y + e, y: b * p.x + d * p.y + f }, docToScreen(V, p));
  });

  it("zoomTo は指定した画面点の下のドキュメント点を動かさない", () => {
    const at = { x: 200, y: 150 };
    const before = screenToDoc(V, at);
    const z = zoomTo(V, 4, at);
    expect(z.scale).toBe(4);
    close(screenToDoc(z, at), before);
  });

  it("倍率は 2%〜3200% に制限される", () => {
    expect(zoomTo(V, 1000, { x: 0, y: 0 }).scale).toBe(32);
    expect(zoomTo(V, 0, { x: 0, y: 0 }).scale).toBe(0.02);
  });

  it("panBy は平行移動だけ変える", () => {
    expect(panBy(V, 5, -3)).toEqual({ ...V, tx: 35, ty: -15 });
  });

  it("nextPreset は段階的に拡大・縮小する", () => {
    expect(nextPreset(1, 1)).toBe(1.5);
    expect(nextPreset(1, -1)).toBeCloseTo(0.6667, 4);
    expect(nextPreset(1.2, 1)).toBe(1.5);
    expect(nextPreset(1.2, -1)).toBe(1);
  });

  it("fitView は中央に収め、回転時は外接矩形で収める", () => {
    const v = fitView(800, 400, 1000, 600, 0, 20);
    expect(v.scale).toBeCloseTo(960 / 800, 6);
    close(docToScreen(v, { x: 400, y: 200 }), { x: 500, y: 300 });
    const r = fitView(800, 400, 1000, 600, Math.PI / 2, 20);
    // 90° 回転で 400×800 の外接矩形 → 高さ 560/800
    expect(r.scale).toBeCloseTo(560 / 800, 6);
    close(docToScreen(r, { x: 400, y: 200 }), { x: 500, y: 300 });
  });

  it("pinch: 2 本指の拡大で中点の下のドキュメント点が中点についてくる", () => {
    const start: ViewTransform = { scale: 1, rotation: 0, tx: 0, ty: 0 };
    const v = pinch(start, { x: 100, y: 100 }, { x: 200, y: 100 }, { x: 150, y: 200 }, { x: 350, y: 200 });
    expect(v.scale).toBeCloseTo(2, 6);
    close(screenToDoc(v, { x: 250, y: 200 }), { x: 150, y: 100 });
  });

  it("pinch: ひねりで回転し、allowRotate=false では回転しない", () => {
    const start: ViewTransform = { scale: 1, rotation: 0, tx: 0, ty: 0 };
    const p1 = { x: 0, y: 0 }, p2 = { x: 100, y: 0 }, q1 = { x: 50, y: -50 }, q2 = { x: 50, y: 50 };
    expect(pinch(start, p1, p2, q1, q2).rotation).toBeCloseTo(Math.PI / 2, 6);
    expect(pinch(start, p1, p2, q1, q2, false).rotation).toBe(0);
  });

  it("rotateTo は中心点の下のドキュメント点を保つ", () => {
    const c = { x: 300, y: 200 };
    const before = screenToDoc(V, c);
    close(screenToDoc(rotateTo(V, -1.2, c), c), before);
  });

  it("角度の正規化と 90° 単位の吸着", () => {
    expect(normalizeAngle(3 * Math.PI)).toBeCloseTo(-Math.PI, 6);
    expect(snapRotation((3 * Math.PI) / 180)).toBe(0);
    expect(snapRotation((88 * Math.PI) / 180)).toBeCloseTo(Math.PI / 2, 6);
    expect(snapRotation((20 * Math.PI) / 180)).toBeCloseTo((20 * Math.PI) / 180, 6);
  });
});
