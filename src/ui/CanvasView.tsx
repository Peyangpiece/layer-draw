import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { createCanvas } from "../core/bitmapStore";
import { findNode } from "../core/document";
import type { Point } from "../core/partOps";
import type { LayerDocument } from "../core/types";
import { Canvas2DCompositor } from "../render/compositor";
import { toHex } from "../decompose/color";
import { StrokeSession, type BrushSettings } from "../paint/strokeSession";
import { collectBitmapIds } from "../store/buildFromImport";
import { useEditor } from "../store/editorStore";
import { hitTestPart, moveBrush, pickMoveTarget, pickSplitTarget, splitLayer } from "../store/partActions";
import {
  cssTransform, fitView, panBy, pinch, rotateTo, screenToDoc, snapRotation, zoomTo, type Pt, type ViewTransform,
} from "./viewport";

export type CanvasTool = "select" | "split" | "move" | "pen" | "eraser" | "picker" | "hand";
export type MessageKind = "info" | "error";

/** これ以下の移動（CSS px）なら「タップ」とみなす */
const TAP_SLOP = 6;
/** 複数本指タップ（取り消し/やり直し）とみなす最大時間（ms） */
const MULTI_TAP_MS = 300;
/** ピンチ中、この角度（度）を超えてひねったら回転を有効にする（拡大だけのつもりで傾くのを防ぐ） */
const ROTATE_THRESHOLD_DEG = 10;
/** ペン・消しゴム中に指でこの時間（ms）動かさずに押し続けたらスポイトにする */
const LONG_PRESS_MS = 500;

type Gesture =
  | { kind: "none" }
  | { kind: "tool"; id: number; start: Pt; stroke: Point[] | null; targetId?: string }
  | { kind: "pan"; id: number; last: Pt }
  /** スポイト: 押している間は拾う色が追従し、離した時点で確定する */
  | { kind: "pick"; id: number; hex: string | null }
  | {
      kind: "pinch";
      ids: [number, number];
      startView: ViewTransform;
      p1: Pt;
      p2: Pt;
      rotate: boolean;
    };

export interface CanvasViewProps {
  doc: LayerDocument;
  tool: CanvasTool;
  multiSelect: boolean;
  /** パーツ移動ブラシの直径（ドキュメント px） */
  brushSize: number;
  /** ペン・消しゴムの設定 */
  paint: { pen: BrushSettings & { color: string }; eraser: BrushSettings };
  /** スポイトで色を拾ったとき */
  onPickColor: (hex: string) => void;
  /** スポイトツールで色を拾い終えたとき（前のツールに戻す） */
  onPickerDone: () => void;
  view: ViewTransform | null;
  setView: Dispatch<SetStateAction<ViewTransform | null>>;
  onViewportSize: (w: number, h: number) => void;
  onMessage: (m: string, kind?: MessageKind) => void;
  onCursor: (p: Pt | null) => void;
}

/**
 * キャンバスの表示と操作。
 * - 合成用キャンバスとオーバーレイ（選択の強調・分割線）を、表示変換（CSS transform）で拡大・回転・移動して表示する
 * - 操作: ツール（選択のタップ / 分割の線引き）、移動（手のひら・Space・中ボタン・ホイール）、
 *   ピンチ（拡大・回転・移動）、Ctrl/Cmd+ホイール（拡大）、2 本指タップ（取り消し）・3 本指タップ（やり直し）
 */
export function CanvasView({ doc, tool, multiSelect, brushSize, paint, onPickColor, onPickerDone, view, setView, onViewportSize, onMessage, onCursor }: CanvasViewProps) {
  const { state, dispatch, bitmaps } = useEditor();
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const brushPreviewRef = useRef<HTMLCanvasElement>(null);
  const brushCursorRef = useRef<HTMLDivElement>(null);
  const pickerRingRef = useRef<HTMLDivElement>(null);
  const longPressRef = useRef(0);
  const compositor = useMemo(() => new Canvas2DCompositor(bitmaps), [bitmaps]);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);

  const pointers = useRef(new Map<number, Pt>());
  const gesture = useRef<Gesture>({ kind: "none" });
  // 複数本指タップ判定用
  const multi = useRef<{ start: number; maxPointers: number; moved: number; origins: Map<number, Pt> } | null>(null);
  // 最新の表示変換。ジェスチャー中は setView の反映（再描画）を待たずに同期的に更新する
  const viewRef = useRef(view);
  viewRef.current = view;
  const applyView = (v: ViewTransform) => {
    viewRef.current = v;
    setView(v);
  };

  // ---- ビューポートの大きさ ----
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth, h = el.clientHeight;
      setSize((prev) => {
        // 大きさが変わったら、画面中央の位置を保つよう平行移動を補正する
        if (prev) setView((v) => (v ? panBy(v, (w - prev.w) / 2, (h - prev.h) / 2) : v));
        return { w, h };
      });
      onViewportSize(w, h);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [setView, onViewportSize]);

  // ドキュメントを開いたら画面に合わせる
  useEffect(() => {
    if (size) setView(fitView(doc.width, doc.height, size.w, size.h));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id, size !== null]);

  // ---- ペン・消しゴム: 描いている途中は、そのレイヤーだけ描きかけの画像に置き換えて合成する ----
  const paintRef = useRef<{ session: StrokeSession; layerId: string } | null>(null);
  const rafRef = useRef(0);
  const renderNow = () => {
    const c = canvasRef.current;
    if (!c) return;
    const ps = paintRef.current;
    if (ps) ps.session.updatePreview();
    compositor.render(doc, c, ps ? new Map([[ps.layerId, ps.session.override]]) : undefined);
  };
  const scheduleRender = () => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      renderNow();
    });
  };
  const cursorSize = tool === "pen" ? paint.pen.size : tool === "eraser" ? paint.eraser.size : brushSize;

  // ---- 合成 ----
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const raf = requestAnimationFrame(() => compositor.render(doc, c));
    return () => cancelAnimationFrame(raf);
  }, [doc, compositor]);

  // ---- オーバーレイ: 選択中パーツの強調と、描画中の分割線 ----
  const scale = view?.scale ?? 1;
  const drawOverlay = useCallback(() => {
    const o = overlayRef.current;
    if (!o) return;
    if (o.width !== doc.width || o.height !== doc.height) {
      o.width = doc.width;
      o.height = doc.height;
    }
    const ctx = o.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, o.width, o.height);
    const accent = getComputedStyle(o).getPropertyValue("--accent").trim() || "#3b82f6";

    // 選択中のレイヤーの強調（半透明のアクセント色）。ペン・消しゴム・スポイトでは実際の色が分からなくなるので出さない
    const tintSelection = tool !== "pen" && tool !== "eraser" && tool !== "picker";
    for (const id of tintSelection ? state.selectedIds : []) {
      const n = findNode(doc.root, id);
      if (!n || n.kind !== "raster" || !n.visible) continue;
      const src = bitmaps.getCanvas(n.bitmapId);
      if (!src) continue;
      const tmp = createCanvas(n.bounds.w, n.bounds.h);
      const t = tmp.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
      t.drawImage(src, 0, 0);
      t.globalCompositeOperation = "source-in";
      t.fillStyle = accent;
      t.fillRect(0, 0, n.bounds.w, n.bounds.h);
      ctx.globalAlpha = 0.4;
      ctx.drawImage(tmp, n.bounds.x, n.bounds.y);
      ctx.globalAlpha = 1;
    }

    const g = gesture.current;
    const stroke = g.kind === "tool" ? g.stroke : null;
    if (stroke && stroke.length > 0) {
      // 画面上で一定の太さに見えるよう、倍率で割る
      ctx.lineWidth = 2 / scale;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.setLineDash([6 / scale, 4 / scale]);
      ctx.beginPath();
      ctx.moveTo(stroke[0]!.x, stroke[0]!.y);
      for (const p of stroke.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.strokeStyle = "rgba(0,0,0,.6)";
      ctx.lineDashOffset = 0;
      ctx.stroke();
      ctx.strokeStyle = accent;
      ctx.lineDashOffset = 5 / scale;
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }, [doc, state.selectedIds, bitmaps, scale, tool]);

  useEffect(() => {
    drawOverlay();
  }, [drawOverlay]);

  // ---- Space キー（一時的な手のひら） ----
  useEffect(() => {
    const isTyping = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(t.tagName));
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !isTyping(e.target)) {
        e.preventDefault();
        setSpaceHeld(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceHeld(false);
    };
    const blur = () => setSpaceHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  // ---- ホイール: Ctrl/Cmd で拡大縮小（トラックパッドのピンチも ctrlKey 付きで届く）、それ以外は移動 ----
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
      const rect = el.getBoundingClientRect();
      const at = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * unit * 0.0025);
        setView((v) => (v ? zoomTo(v, v.scale * factor, at) : v));
      } else {
        let dx = e.deltaX * unit, dy = e.deltaY * unit;
        if (e.shiftKey && dx === 0) [dx, dy] = [dy, 0];
        setView((v) => (v ? panBy(v, -dx, -dy) : v));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [setView]);

  // ---- パーツ移動ブラシ: なぞった範囲のプレビューとカーソル ----
  /** プレビュー用キャンバスに線分を追記する（全体を描き直さない）。半透明は CSS の opacity で付けるので重なっても濃くならない */
  const drawBrushSegment = (a: Point, b: Point, color: string) => {
    const c = brushPreviewRef.current;
    if (!c) return;
    if (c.width !== doc.width || c.height !== doc.height) {
      c.width = doc.width;
      c.height = doc.height;
    }
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = brushSize;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    if (a === b) {
      ctx.arc(a.x, a.y, brushSize / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  };
  const clearBrushPreview = () => {
    const c = brushPreviewRef.current;
    c?.getContext("2d")?.clearRect(0, 0, c.width, c.height);
  };
  /** ブラシの円カーソル（画面座標）。React の再描画を介さず直接動かす */
  const lastHover = useRef<Pt | null>(null);
  const moveBrushCursor = (p: Pt | null) => {
    lastHover.current = p;
    const el = brushCursorRef.current;
    if (!el) return;
    if (!p || (tool !== "move" && tool !== "pen" && tool !== "eraser") || spaceHeld) {
      el.style.display = "none";
      return;
    }
    const d = Math.max(4, cursorSize * (viewRef.current?.scale ?? 1));
    el.style.display = "block";
    el.style.width = `${d}px`;
    el.style.height = `${d}px`;
    el.style.transform = `translate(${p.x - d / 2}px, ${p.y - d / 2}px)`;
  };
  // サイズ・倍率・ツールが変わったら、マウスを動かさなくても円カーソルを描き直す
  useEffect(() => {
    moveBrushCursor(lastHover.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursorSize, view?.scale, tool, spaceHeld]);
  const targetColor = (id: string | undefined) => {
    const n = id ? findNode(doc.root, id) : undefined;
    return (n?.kind === "raster" && n.part?.fillColor) || getComputedStyle(viewportRef.current!).getPropertyValue("--accent").trim() || "#4c8dff";
  };

  // ---- ポインター ----
  const local = (e: { clientX: number; clientY: number }): Pt => {
    const r = viewportRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const toDoc = (p: Pt): Point => (viewRef.current ? screenToDoc(viewRef.current, p) : p);

  const startPinch = () => {
    const ids = [...pointers.current.keys()].slice(0, 2) as [number, number];
    const v = viewRef.current;
    if (!v) return;
    gesture.current = {
      kind: "pinch",
      ids,
      startView: v,
      p1: pointers.current.get(ids[0])!,
      p2: pointers.current.get(ids[1])!,
      rotate: false,
    };
  };

  /** ペン（スタイラス）だけ筆圧を使う。マウスは押している間 0.5 を返し、指は 0 のことがあるので常に 1 とする */
  const pressureOf = (e: PointerEvent | React.PointerEvent) => (e.pointerType === "pen" ? (e.pressure > 0 ? e.pressure : 0.5) : 1);

  const startPaint = (e: React.PointerEvent, p: Pt) => {
    const d = toDoc(p);
    if (e.altKey) {
      beginPick(e.pointerId, p);
      return;
    }
    const id = state.selectedIds[state.selectedIds.length - 1];
    const target = id ? findNode(doc.root, id) : undefined;
    const what = tool === "pen" ? "描く" : "消す";
    if (!target) return onMessage(`${what}レイヤーを、レイヤー一覧で選んでください`, "error");
    if (target.kind !== "raster") return onMessage(`フォルダには${what === "描く" ? "描けません" : "使えません"}。レイヤーを選んでください`, "error");
    if (!target.visible) return onMessage(`「${target.name}」は非表示のため${what === "描く" ? "描けません" : "消せません"}`, "error");
    if (target.locked) return onMessage(`「${target.name}」はロックされています`, "error");
    if (tool === "eraser" && target.alphaLocked) return onMessage(`「${target.name}」は透明度保護中のため、消しゴムは使えません`, "error");

    // 取り消し履歴から参照されなくなった画像を解放してから始める（描くたびに新しい画像ができるため）
    const h = state.history;
    if (h) {
      const live = collectBitmapIds([...h.past, h.present, ...h.future, ...(h.pending ? [h.pending] : [])]);
      bitmaps.gc(live);
    }
    const s = tool === "pen" ? paint.pen : paint.eraser;
    const session = new StrokeSession(bitmaps.get(target.bitmapId), target.bounds, doc.width, doc.height, {
      ...s,
      mode: tool === "pen" ? "pen" : "eraser",
      color: paint.pen.color,
      alphaLocked: target.alphaLocked,
    });
    session.add(d.x, d.y, pressureOf(e));
    paintRef.current = { session, layerId: target.id };
    gesture.current = { kind: "tool", id: e.pointerId, start: p, stroke: null };
    scheduleRender();
    // 指で長押し → スポイト（描きかけの点は捨てる）。スタイラス・マウスはゆっくり描き始めることがあるので対象外
    if (e.pointerType === "touch") {
      const pid = e.pointerId;
      clearTimeout(longPressRef.current);
      longPressRef.current = window.setTimeout(() => {
        const g = gesture.current;
        if (g.kind !== "tool" || g.id !== pid || !paintRef.current) return;
        paintRef.current = null;
        renderNow();
        beginPick(pid, pointers.current.get(pid) ?? p);
      }, LONG_PRESS_MS);
    }
  };

  // ---- スポイト ----
  /** 表示中の色（全レイヤーの合成結果）を拾う。透明な所は白い紙の上の色とみなす。キャンバスの外は null */
  const sampleAt = (p: Pt): string | null => {
    const d = toDoc(p), c = canvasRef.current, x = Math.floor(d.x), y = Math.floor(d.y);
    if (!c || x < 0 || y < 0 || x >= doc.width || y >= doc.height) return null;
    const px = c.getContext("2d")!.getImageData(x, y, 1, 1).data, a = px[3]! / 255;
    return toHex(px[0]! * a + 255 * (1 - a), px[1]! * a + 255 * (1 - a), px[2]! * a + 255 * (1 - a));
  };
  /** 拾っている色の表示（指で隠れないよう、押している位置の少し上に出す）。上半分が新しい色、下半分が今の色 */
  const showPickerRing = (p: Pt | null, hex: string | null) => {
    const el = pickerRingRef.current;
    if (!el) return;
    if (!p) {
      el.style.display = "none";
      return;
    }
    const vw = viewportRef.current?.clientWidth ?? 0;
    const R = 44;
    const cx = Math.min(Math.max(p.x, R + 4), vw - R - 4), cy = Math.max(p.y - 90, R + 4);
    el.style.display = "block";
    el.style.transform = `translate(${cx - R}px, ${cy - R}px)`;
    (el.firstElementChild as HTMLElement).style.background = hex ?? "transparent";
    (el.lastElementChild as HTMLElement).style.background = paint.pen.color;
  };
  const beginPick = (pointerId: number, p: Pt) => {
    const hex = sampleAt(p);
    gesture.current = { kind: "pick", id: pointerId, hex };
    moveBrushCursor(null);
    showPickerRing(p, hex);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const p = local(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, p);

    if (e.pointerType === "touch") {
      const now = performance.now();
      if (pointers.current.size === 1) multi.current = { start: now, maxPointers: 1, moved: 0, origins: new Map([[e.pointerId, p]]) };
      else if (multi.current) {
        multi.current.maxPointers = Math.max(multi.current.maxPointers, pointers.current.size);
        multi.current.origins.set(e.pointerId, p);
      }
      if (pointers.current.size >= 2) {
        // 2 本目の指: ツール操作を取り消してピンチへ
        clearTimeout(longPressRef.current);
        if (gesture.current.kind === "pick") {
          gesture.current = { kind: "none" };
          showPickerRing(null, null);
        }
        if (gesture.current.kind === "tool") {
          gesture.current = { kind: "none" };
          drawOverlay();
          clearBrushPreview();
          if (paintRef.current) {
            // 描きかけのストロークは捨てる（2 本指の操作に切り替え）
            paintRef.current = null;
            renderNow();
          }
        }
        moveBrushCursor(null);
        if (gesture.current.kind !== "pinch") startPinch();
        return;
      }
    }

    if (gesture.current.kind !== "none") return;
    const wantsPan = e.button === 1 || (e.button === 0 && (tool === "hand" || spaceHeld));
    if (wantsPan) {
      gesture.current = { kind: "pan", id: e.pointerId, last: p };
      setPanning(true);
      return;
    }
    if (e.button !== 0) return;
    if (tool === "picker") {
      beginPick(e.pointerId, p);
      return;
    }
    if (tool === "pen" || tool === "eraser") {
      startPaint(e, p);
      return;
    }
    if (tool === "move") {
      const start = toDoc(p);
      const target = pickMoveTarget(doc, bitmaps, state.selectedIds, start);
      if (!target) {
        onMessage("移動先のパーツを選択するか、移動先にしたいパーツの上からなぞり始めてください。", "error");
        gesture.current = { kind: "none" };
        return;
      }
      gesture.current = { kind: "tool", id: e.pointerId, start: p, stroke: [start], targetId: target.id };
      drawBrushSegment(start, start, targetColor(target.id));
      return;
    }
    gesture.current = { kind: "tool", id: e.pointerId, start: p, stroke: tool === "split" ? [toDoc(p)] : null };
    if (tool === "split") drawOverlay();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = local(e);
    if (e.pointerType !== "touch" || pointers.current.has(e.pointerId)) onCursor(toDoc(p));
    if (pointers.current.size <= 1) moveBrushCursor(p);
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, p);
    if (multi.current) {
      const o = multi.current.origins.get(e.pointerId);
      if (o) multi.current.moved = Math.max(multi.current.moved, Math.hypot(p.x - o.x, p.y - o.y));
    }

    const g = gesture.current;
    if (g.kind === "pan" && g.id === e.pointerId) {
      const dx = p.x - g.last.x, dy = p.y - g.last.y;
      g.last = p;
      if (viewRef.current) applyView(panBy(viewRef.current, dx, dy));
    } else if (g.kind === "pinch") {
      const q1 = pointers.current.get(g.ids[0]), q2 = pointers.current.get(g.ids[1]);
      if (!q1 || !q2) return;
      if (!g.rotate) {
        const a0 = Math.atan2(g.p2.y - g.p1.y, g.p2.x - g.p1.x);
        const a1 = Math.atan2(q2.y - q1.y, q2.x - q1.x);
        let d = Math.abs(a1 - a0);
        if (d > Math.PI) d = 2 * Math.PI - d;
        if ((d * 180) / Math.PI > ROTATE_THRESHOLD_DEG) {
          // 回転を有効化。現在の指の位置での（回転なしの）表示を起点にし直して、しきい値の分だけ急に回らないようにする。
          // 起点の表示と起点の指の位置は、同じ時点のものでなければならない（ずれると中点の下の絵が動く）
          g.startView = pinch(g.startView, g.p1, g.p2, q1, q2, false);
          g.rotate = true;
          g.p1 = q1;
          g.p2 = q2;
        }
      }
      applyView(pinch(g.startView, g.p1, g.p2, q1, q2, g.rotate));
    } else if (g.kind === "pick" && g.id === e.pointerId) {
      g.hex = sampleAt(p);
      showPickerRing(p, g.hex);
    } else if (g.kind === "tool" && g.id === e.pointerId && paintRef.current) {
      // 長押しの判定中に動かしたら、スポイトにはしない
      if (Math.hypot(p.x - g.start.x, p.y - g.start.y) > TAP_SLOP) clearTimeout(longPressRef.current);
      // ペンの途中の位置（まとめて届く分）もすべて使う
      const evs = (e.nativeEvent.getCoalescedEvents?.() ?? []) as PointerEvent[];
      for (const ev of evs.length > 0 ? evs : [e.nativeEvent]) {
        const d = toDoc(local(ev));
        paintRef.current.session.add(d.x, d.y, pressureOf(ev));
      }
      scheduleRender();
    } else if (g.kind === "tool" && g.id === e.pointerId && g.stroke) {
      const d = toDoc(p);
      const last = g.stroke[g.stroke.length - 1]!;
      if (Math.hypot(d.x - last.x, d.y - last.y) * (viewRef.current?.scale ?? 1) < 1) return;
      g.stroke.push(d);
      if (tool === "move") drawBrushSegment(last, d, targetColor(g.targetId));
      else drawOverlay();
    }
  };

  const endPointer = (e: React.PointerEvent, cancelled: boolean) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = local(e);
    pointers.current.delete(e.pointerId);
    if (e.pointerType === "touch") moveBrushCursor(null); // 指を離したら円カーソルを消す
    const g = gesture.current;

    if (g.kind === "pinch") {
      if (pointers.current.size >= 2) {
        startPinch(); // 3 本以上のうち 1 本が離れた → 残りで続行
        return;
      }
      // 回転を 90° 単位に吸着
      const v = viewRef.current;
      if (v && size) applyView(rotateTo(v, snapRotation(v.rotation), { x: size.w / 2, y: size.h / 2 }));
      gesture.current = { kind: "none" };
      if (pointers.current.size === 0) finishMultiTap(cancelled);
      return;
    }
    if (pointers.current.size === 0 && e.pointerType === "touch") {
      // 1 本指のジェスチャー終了時にも複数本指タップ判定をリセット
      if (multi.current && multi.current.maxPointers >= 2) {
        finishMultiTap(cancelled);
        gesture.current = { kind: "none" };
        return;
      }
      multi.current = null;
    }

    if (g.kind === "pan" && g.id === e.pointerId) {
      gesture.current = { kind: "none" };
      setPanning(false);
      return;
    }
    if (g.kind === "pick" && g.id === e.pointerId) {
      gesture.current = { kind: "none" };
      showPickerRing(null, null);
      if (cancelled) return;
      if (!g.hex) {
        // 拾えなかったときはスポイトのまま（やり直せるように）
        onMessage("キャンバスの外では色を拾えません", "error");
        return;
      }
      onPickColor(g.hex);
      onMessage(`色を取得しました（${g.hex}）`);
      if (tool === "picker") onPickerDone();
      return;
    }
    if (g.kind !== "tool" || g.id !== e.pointerId) return;
    gesture.current = { kind: "none" };
    clearTimeout(longPressRef.current);
    const ps = paintRef.current;
    paintRef.current = null;
    if (cancelled) {
      drawOverlay();
      clearBrushPreview();
      if (ps) renderNow();
      return;
    }

    if (ps) {
      // ストロークを確定: 新しい画像に差し替える（1 回の取り消し単位）
      const result = ps.session.finish();
      const bitmapId = bitmaps.add(result.image);
      dispatch({ type: "updateLayers", updates: [{ id: ps.layerId, bitmapId, bounds: result.bounds }], remove: [], select: [ps.layerId] });
      return;
    }

    if (tool === "move") {
      clearBrushPreview();
      const target = g.targetId ? findNode(doc.root, g.targetId) : undefined;
      if (!g.stroke || !target || target.kind !== "raster") return;
      const result = moveBrush(doc, bitmaps, target, g.stroke, brushSize / 2);
      if (!result.ok) {
        onMessage(result.reason, "error");
        return;
      }
      dispatch(result.action);
      onMessage(result.message);
      return;
    }

    if (tool === "select") {
      if (Math.hypot(p.x - g.start.x, p.y - g.start.y) > TAP_SLOP) return;
      const d = toDoc(p);
      const hit = hitTestPart(doc, bitmaps, d.x, d.y);
      const modifier = e.shiftKey || e.ctrlKey || e.metaKey;
      if (hit) dispatch({ type: "select", id: hit.id, mode: multiSelect || modifier ? "toggle" : "replace" });
      // 何も無い所のタップは選択解除（複数選択モードでも。タッチでは他に解除手段が無いため）。修飾キー付きは追加の意図なので解除しない
      else if (!modifier) dispatch({ type: "select", id: null });
      return;
    }

    if (tool === "split") {
      const stroke = g.stroke;
      drawOverlay();
      if (!stroke || stroke.length < 2) {
        onMessage("パーツを横切るように線を引いてください。", "error");
        return;
      }
      const target = pickSplitTarget(doc, bitmaps, state.selectedIds, stroke);
      if (!target) {
        onMessage("線の下にパーツがありません。", "error");
        return;
      }
      const result = splitLayer(bitmaps, target, stroke);
      if (!result.ok) {
        onMessage(result.reason, "error");
        return;
      }
      dispatch(result.action);
      onMessage(result.message);
    }
  };

  /** すべての指が離れたとき: 短く動かさない 2 本指タップ → 取り消し、3 本指 → やり直し */
  const finishMultiTap = (cancelled: boolean) => {
    const m = multi.current;
    multi.current = null;
    if (!m || cancelled) return;
    if (performance.now() - m.start > MULTI_TAP_MS || m.moved > TAP_SLOP * 2) return;
    if (m.maxPointers === 2) {
      dispatch({ type: "undo" });
      onMessage("取り消しました");
    } else if (m.maxPointers === 3) {
      dispatch({ type: "redo" });
      onMessage("やり直しました");
    }
  };

  const cursor = panning
    ? "grabbing"
    : tool === "hand" || spaceHeld
      ? "grab"
      : tool === "split"
        ? "crosshair"
        : tool === "move"
          ? "none" // 円カーソルを表示
          : tool === "pen" || tool === "eraser" || tool === "picker"
            ? "crosshair" // ペン・消しゴムは円カーソルと併用（小さいブラシでも位置が分かるように）
          : "default";
  const stageStyle: React.CSSProperties = view
    ? { width: doc.width, height: doc.height, transform: cssTransform(view) }
    : { width: doc.width, height: doc.height, visibility: "hidden" };
  // 400% 以上では画素をぼかさずに表示する（画素単位の確認用）。
  // それ未満で最近傍補間にすると、回転時にアンチエイリアスの縁がギザギザ・まだらに見えるため滑らかに表示する
  const rendering = (view?.scale ?? 1) >= 4 ? "pixelated" : "auto";

  return (
    <div
      ref={viewportRef}
      className="viewport"
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => endPointer(e, false)}
      onPointerCancel={(e) => endPointer(e, true)}
      onPointerLeave={(e) => {
        if (e.pointerType !== "touch") onCursor(null);
        moveBrushCursor(null);
      }}
      onContextMenu={(e) => e.preventDefault()}
      onAuxClick={(e) => e.preventDefault()}
    >
      <div className="stage" style={stageStyle}>
        <canvas ref={canvasRef} className="stage-canvas" style={{ imageRendering: rendering }} aria-label={`キャンバス ${doc.name}`} />
        <canvas ref={brushPreviewRef} className="stage-canvas brush-preview" />
        <canvas ref={overlayRef} className="stage-canvas" />
      </div>
      <div ref={brushCursorRef} className="brush-cursor" aria-hidden />
      <div ref={pickerRingRef} className="picker-ring" aria-hidden>
        <div className="picker-new" />
        <div className="picker-old" />
      </div>
    </div>
  );
}
