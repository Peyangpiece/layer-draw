import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { createCanvas } from "../core/bitmapStore";
import { findNode } from "../core/document";
import type { Point } from "../core/partOps";
import type { LayerDocument } from "../core/types";
import { Canvas2DCompositor } from "../render/compositor";
import { useEditor } from "../store/editorStore";
import { hitTestPart, pickSplitTarget, splitLayer } from "../store/partActions";
import {
  cssTransform, fitView, panBy, pinch, rotateTo, screenToDoc, snapRotation, zoomTo, type Pt, type ViewTransform,
} from "./viewport";

export type CanvasTool = "select" | "split" | "hand";
export type MessageKind = "info" | "error";

/** これ以下の移動（CSS px）なら「タップ」とみなす */
const TAP_SLOP = 6;
/** 複数本指タップ（取り消し/やり直し）とみなす最大時間（ms） */
const MULTI_TAP_MS = 300;
/** ピンチ中、この角度（度）を超えてひねったら回転を有効にする（拡大だけのつもりで傾くのを防ぐ） */
const ROTATE_THRESHOLD_DEG = 10;

type Gesture =
  | { kind: "none" }
  | { kind: "tool"; id: number; start: Pt; stroke: Point[] | null }
  | { kind: "pan"; id: number; last: Pt }
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
export function CanvasView({ doc, tool, multiSelect, view, setView, onViewportSize, onMessage, onCursor }: CanvasViewProps) {
  const { state, dispatch, bitmaps } = useEditor();
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
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

    for (const id of state.selectedIds) {
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
  }, [doc, state.selectedIds, bitmaps, scale]);

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
        if (gesture.current.kind === "tool") {
          gesture.current = { kind: "none" };
          drawOverlay();
        }
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
    gesture.current = { kind: "tool", id: e.pointerId, start: p, stroke: tool === "split" ? [toDoc(p)] : null };
    if (tool === "split") drawOverlay();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = local(e);
    if (e.pointerType !== "touch" || pointers.current.has(e.pointerId)) onCursor(toDoc(p));
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
    } else if (g.kind === "tool" && g.id === e.pointerId && g.stroke) {
      const d = toDoc(p);
      const last = g.stroke[g.stroke.length - 1]!;
      if (Math.hypot(d.x - last.x, d.y - last.y) * (viewRef.current?.scale ?? 1) < 1) return;
      g.stroke.push(d);
      drawOverlay();
    }
  };

  const endPointer = (e: React.PointerEvent, cancelled: boolean) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = local(e);
    pointers.current.delete(e.pointerId);
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
    if (g.kind !== "tool" || g.id !== e.pointerId) return;
    gesture.current = { kind: "none" };
    if (cancelled) {
      drawOverlay();
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

  const cursor = panning ? "grabbing" : tool === "hand" || spaceHeld ? "grab" : tool === "split" ? "crosshair" : "default";
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
      }}
      onContextMenu={(e) => e.preventDefault()}
      onAuxClick={(e) => e.preventDefault()}
    >
      <div className="stage" style={stageStyle}>
        <canvas ref={canvasRef} className="stage-canvas" style={{ imageRendering: rendering }} aria-label={`キャンバス ${doc.name}`} />
        <canvas ref={overlayRef} className="stage-canvas" />
      </div>
    </div>
  );
}
