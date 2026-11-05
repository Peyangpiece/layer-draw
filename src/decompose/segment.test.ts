import { describe, expect, it } from "vitest";
import { squaredEdt } from "./edt";
import { extractLineart } from "./lineart";
import { decompose } from "./pipeline";
import { segment } from "./segment";
import { Sketch } from "./testImages";
import { DEFAULT_DECOMPOSE_PARAMS, type SegmentParams } from "./types";

const LP = DEFAULT_DECOMPOSE_PARAMS.lineart;
const SP: SegmentParams = { ...DEFAULT_DECOMPOSE_PARAMS.segment, minAreaRatio: 0 };
const seg = (s: Sketch, p: Partial<SegmentParams> = {}) => {
  const img = s.image();
  return segment(extractLineart(img, LP), img, { ...SP, ...p });
};
const labelAt = (r: ReturnType<typeof segment>, x: number, y: number) => r.labels[y * r.width + x]!;

describe("squaredEdt", () => {
  it("総当たりと一致する", () => {
    const w = 23, h = 17;
    const mask = new Uint8Array(w * h);
    const pts = [[3, 4], [20, 1], [10, 15], [11, 15]];
    for (const [x, y] of pts) mask[y! * w + x!] = 1;
    const d = squaredEdt(mask, w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const brute = Math.min(...pts.map(([px, py]) => (x - px!) ** 2 + (y - py!) ** 2));
      expect(d[y * w + x]).toBe(brute);
    }
  });
});

describe("segment", () => {
  it("枠で仕切られた 2 つの領域を別パーツにし、外側は背景にする", () => {
    const s = new Sketch(100, 60);
    s.strokeRect(10, 10, 80, 40, 3);
    s.fillRect(48, 10, 3, 40); // 中央の仕切り
    const r = seg(s);
    const left = labelAt(r, 25, 30), right = labelAt(r, 75, 30), outside = labelAt(r, 2, 2);
    expect(left).not.toBe(right);
    expect(r.isBackground[outside]).toBe(true);
    expect(r.isBackground[left]).toBe(false);
    expect(r.isBackground[right]).toBe(false);
    expect(r.isBackground.filter((b) => !b).length).toBe(2);
  });

  it("すべての画素が（線の下も含めて）いずれかの領域に割り当てられる = 線下補完", () => {
    const s = new Sketch(100, 60);
    s.strokeRect(10, 10, 80, 40, 5);
    s.fillRect(48, 10, 5, 40);
    const r = seg(s);
    expect(r.labels.every((l) => l >= 0)).toBe(true);
    // 仕切り線（x=48..52）の内部は左右どちらかのパーツに割り当てられ、背景にはならない
    for (let x = 48; x <= 52; x++) expect(r.isBackground[labelAt(r, x, 30)]).toBe(false);
    // 線の中央付近を境に左右に分かれる
    expect(labelAt(r, 48, 30)).toBe(labelAt(r, 25, 30));
    expect(labelAt(r, 52, 30)).toBe(labelAt(r, 75, 30));
  });

  it("隙間閉じ: 幅 2*gapRadius 以下の途切れは閉じ、それより広い途切れは閉じない", () => {
    const make = (gap: number) => {
      const s = new Sketch(120, 120);
      s.strokeCircle(60, 60, 40, 3, gap);
      return seg(s, { gapRadius: 2 });
    };
    const closed = make(4);
    expect(closed.isBackground[labelAt(closed, 60, 60)]).toBe(false); // 円の内側が独立したパーツ
    const open = make(9);
    expect(open.isBackground[labelAt(open, 60, 60)]).toBe(true); // 外とつながって背景になる
  });

  it("gapRadius=0 でも 1px の斜め線を塗りが通り抜けない（4 近傍ラベリング）", () => {
    const s = new Sketch(40, 40);
    for (let i = 0; i < 40; i++) s.px(i, i); // 対角線
    const r = seg(s, { gapRadius: 0, borderAsBackground: false });
    expect(labelAt(r, 30, 5)).not.toBe(labelAt(r, 5, 30));
  });

  it("微小領域は境界を最も長く共有する隣接領域に吸収される", () => {
    const s = new Sketch(100, 100);
    s.strokeRect(10, 10, 80, 80, 3);
    s.strokeRect(40, 40, 10, 10, 2); // 内側の小さな枠（内部 6x6）
    const kept = seg(s, { gapRadius: 1 });
    const absorbed = seg(s, { gapRadius: 1, minAreaRatio: 200 / (100 * 100) });
    expect(kept.isBackground.filter((b) => !b).length).toBe(2);
    expect(absorbed.isBackground.filter((b) => !b).length).toBe(1);
  });

  it("maxParts を超えるパーツは小さい順に統合される", () => {
    const s = new Sketch(200, 40);
    s.strokeRect(0, 0, 200, 40, 2);
    for (let x = 20; x < 200; x += 20) s.fillRect(x, 0, 2, 40); // 10 区画
    expect(seg(s, { gapRadius: 1 }).regionCount).toBe(10);
    expect(seg(s, { gapRadius: 1, maxParts: 4 }).isBackground.filter((b) => !b).length).toBe(4);
  });

  it("幅が揺らぐ細い領域が隙間閉じで細切れにならない（断片の統合）", () => {
    const s = new Sketch(300, 100);
    s.strokeRect(0, 0, 300, 100, 2);
    s.fillRect(10, 40, 280, 2); // 上の線
    for (let x = 10; x < 290; x++) {
      const y = Math.round(47 + 2 * Math.sin(x / 4)); // 下の線: 上の線との間隔が 3〜7px で揺らぐ
      s.fillRect(x, y, 1, 2);
    }
    s.fillRect(10, 40, 2, 12); s.fillRect(288, 40, 2, 12); // 両端を閉じる
    const r = seg(s, { gapRadius: 2, borderAsBackground: false });
    // 期待: 細い領域 1 つと、その周り 1 つ（上下は線の両端の外側でつながっている）の計 2 つ
    expect(r.areas.length).toBe(2);
    expect(labelAt(r, 150, 20)).toBe(labelAt(r, 150, 80));
    // 細い領域のどの列でも、内部は同じラベル
    const sliver = new Set<number>();
    for (let x = 20; x < 280; x++) sliver.add(labelAt(r, x, 43));
    expect(sliver.size).toBe(1);
    expect(sliver.has(labelAt(r, 150, 20))).toBe(false);
  });

  it("gapRadius=0 でもアンチエイリアスの縁が灰色の別パーツにならない", () => {
    const s = new Sketch(100, 100);
    s.strokeRect(20, 20, 60, 60, 3);
    // 線の両側に 1px ずつ灰色の縁（アンチエイリアス相当）
    s.strokeRect(19, 19, 62, 62, 1);
    for (const [x, y, w, h] of [[19, 19, 62, 1], [19, 80, 62, 1], [19, 19, 1, 62], [80, 19, 1, 62], [23, 23, 54, 1], [23, 76, 54, 1], [23, 23, 1, 54], [76, 23, 1, 54]] as const)
      s.fillRect(x, y, w, h, [170, 170, 170]);
    const r = seg(s, { gapRadius: 0 });
    const parts = r.isBackground.filter((b) => !b).length;
    expect(parts).toBe(1);
    const inside = labelAt(r, 50, 50);
    expect(r.meanColors[inside]!.map(Math.round)).toEqual([255, 255, 255]);
  });

  it("線で仕切られていない色の境界（黒ベタと白）は別パーツのまま", () => {
    const s = new Sketch(100, 60);
    s.strokeRect(0, 0, 100, 60, 2);
    s.fillRect(2, 2, 48, 56, [20, 20, 20]); // 左半分を黒ベタ（maxLineWidth より太い）
    const r = seg(s, { borderAsBackground: false });
    expect(labelAt(r, 25, 30)).not.toBe(labelAt(r, 75, 30));
  });

  it("ゆるい角度のアンチエイリアスの縁を伝って、色の違う領域どうしがつながらない", () => {
    // 白背景・太い茶色の輪郭（maxLineWidth より太いので線画にならない）・内側ピンク
    const s = new Sketch(700, 500);
    s.fillEllipseAA(350, 250, 300, 200, [90, 58, 58]);
    s.fillEllipseAA(350, 250, 270, 170, [255, 184, 198]);
    const r = seg(s, { gapRadius: 2, borderAsBackground: true });
    const inside = labelAt(r, 350, 250), ring = labelAt(r, 350, 65), outside = labelAt(r, 5, 5);
    expect(inside).not.toBe(outside);
    expect(inside).not.toBe(ring);
    expect(r.isBackground[inside]).toBe(false);
    expect(r.meanColors[inside]!.map(Math.round)).toEqual([255, 184, 198]);
  });

  it("色の差が許容量を少しだけ超える境目（線なし）も、中間色の画素を伝ってつながらない", () => {
    // 体のピンクの上に、少しだけ濃いピンクのハート（ほっぺ）。色差 ≈ 51 > 許容量 40。境目はアンチエイリアス
    const s = new Sketch(400, 300);
    s.fillRect(0, 0, 400, 300, [255, 184, 198]);
    s.fillEllipseAA(200, 150, 90, 60, [255, 143, 168]);
    const r = seg(s, { borderAsBackground: false });
    const heart = labelAt(r, 200, 150), body = labelAt(r, 20, 20);
    expect(heart).not.toBe(body);
    expect(r.meanColors[heart]!.map(Math.round)).toEqual([255, 143, 168]);
  });

  it("照明ムラのようななだらかな色の変化では、領域が帯状に分かれない", () => {
    // 紙の明るさが左 130 → 右 254 に変わる。枠で囲んだ内側は 1 つの領域のまま
    const s = new Sketch(400, 200);
    for (let x = 0; x < 400; x++) { const v = Math.round(130 + (x * 124) / 399); s.fillRect(x, 0, 1, 200, [v, v, v]); }
    s.strokeRect(10, 10, 380, 180, 3);
    const r = seg(s, { borderAsBackground: false });
    expect(labelAt(r, 30, 100)).toBe(labelAt(r, 370, 100));
  });

  it("領域の平均色は元画像の色（線を除く）", () => {
    const s = new Sketch(60, 60);
    s.fillRect(10, 10, 40, 40, [200, 40, 40]);
    s.strokeRect(10, 10, 40, 40, 3);
    const r = seg(s);
    const [cr, cg, cb] = r.meanColors[labelAt(r, 30, 30)]!;
    expect([Math.round(cr), Math.round(cg), Math.round(cb)]).toEqual([200, 40, 40]);
  });
});

describe("decompose（パーツレイヤー生成）", () => {
  it("線画のみの入力は自動配色になり、パーツは外接矩形サイズで面積順に並ぶ", () => {
    const s = new Sketch(100, 60);
    s.strokeRect(10, 10, 80, 40, 3);
    s.fillRect(30, 10, 3, 40);
    const r = decompose(s.image(), { ...DEFAULT_DECOMPOSE_PARAMS, segment: SP });
    expect(r.resolvedFill).toBe("palette");
    expect(r.parts.length).toBe(2);
    expect(r.parts[0]!.area).toBeGreaterThan(r.parts[1]!.area);
    expect(r.parts[0]!.fillColor).not.toBe(r.parts[1]!.fillColor); // 隣接パーツは別の色
    for (const p of r.parts) {
      expect(p.image.width).toBeLessThan(100);
      expect(p.x).toBeGreaterThanOrEqual(10);
    }
  });

  it("色付き入力は元の色で塗られる", () => {
    const s = new Sketch(60, 60);
    s.fillRect(10, 10, 40, 40, [40, 120, 220]);
    s.strokeRect(10, 10, 40, 40, 3);
    const r = decompose(s.image(), { ...DEFAULT_DECOMPOSE_PARAMS, segment: SP });
    expect(r.resolvedFill).toBe("source");
    expect(r.parts[0]!.fillColor).toBe("#2878dc");
  });

  it("線の下まで塗られている: パーツと線画を重ねると、線の内側の領域に背景の白が見えない", () => {
    const s = new Sketch(80, 80);
    s.strokeRect(10, 10, 60, 60, 4);
    const r = decompose(s.image(), { ...DEFAULT_DECOMPOSE_PARAMS, segment: SP });
    const p = r.parts[0]!;
    // 線の内側半分（x=12,13）まではパーツに含まれる
    const covered = (x: number, y: number) => p.image.data[((y - p.y) * p.image.width + (x - p.x)) * 4 + 3] === 255;
    for (let x = 12; x < 68; x++) expect(covered(x, 40)).toBe(true);
  });
});
