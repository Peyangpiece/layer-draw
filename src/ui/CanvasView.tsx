import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createCanvas } from "../core/bitmapStore";
import { findNode } from "../core/document";
import type { Point } from "../core/partOps";
import type { LayerDocument } from "../core/types";
import { Canvas2DCompositor } from "../render/compositor";
import { useEditor } from "../store/editorStore";
import { hitTestPart, pickSplitTarget, splitLayer } from "../store/partActions";

export type CanvasTool = "select" | "split";

/** これ以下の移動（CSS px）なら「タップ」とみなす */
const TAP_SLOP = 6;

/**
 * ドキュメントの合成表示と、キャンバス上の操作（タップ選択・分割の線引き）。
 * 合成用キャンバスの上に同じ大きさのオーバーレイ（選択パーツの強調・描画中の線）を重ねる。
 * 表示倍率はコンテナに収まる最大値（等倍まで）。ズーム・パンは今後実装。
 */
export function CanvasView({
  doc,
  tool,
  multiSelect,
  onMessage,
}: {
  doc: LayerDocument;
  tool: CanvasTool;
  multiSelect: boolean;
  onMessage: (m: string) => void;
}) {
  const { state, dispatch, bitmaps } = useEditor();
  const areaRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const compositor = useMemo(() => new Canvas2DCompositor(bitmaps), [bitmaps]);
  const [scale, setScale] = useState(1);
  const strokeRef = useRef<Point[] | null>(null);
  const downRef = useRef<{ x: number; y: number; id: number } | null>(null);

  // コンテナに収まる表示倍率
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const update = () => {
      const cs = getComputedStyle(el);
      const w = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const h = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      setScale(Math.max(0.01, Math.min(1, w / doc.width, h / doc.height)));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [doc.width, doc.height]);

  // 合成
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const raf = requestAnimationFrame(() => compositor.render(doc, c));
    return () => cancelAnimationFrame(raf);
  }, [doc, compositor]);

  // オーバーレイ: 選択中パーツの強調と、描画中の分割線
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
    const accent = getComputedStyle(o).getPropertyValue("--accent").trim() || "#2f6feb";

    for (const id of state.selectedIds) {
      const n = findNode(doc.root, id);
      if (!n || n.kind !== "raster" || !n.visible) continue;
      const src = bitmaps.getCanvas(n.bitmapId);
      if (!src) continue;
      // パーツの形を半透明のアクセント色で塗る
      const tmp = createCanvas(n.bounds.w, n.bounds.h);
      const t = tmp.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
      t.drawImage(src, 0, 0);
      t.globalCompositeOperation = "source-in";
      t.fillStyle = accent;
      t.fillRect(0, 0, n.bounds.w, n.bounds.h);
      ctx.globalAlpha = 0.45;
      ctx.drawImage(tmp, n.bounds.x, n.bounds.y);
      ctx.globalAlpha = 1;
    }

    const stroke = strokeRef.current;
    if (stroke && stroke.length > 0) {
      ctx.strokeStyle = accent;
      ctx.lineWidth = Math.max(2, 2 / scale);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.setLineDash([Math.max(4, 6 / scale), Math.max(3, 4 / scale)]);
      ctx.beginPath();
      ctx.moveTo(stroke[0]!.x, stroke[0]!.y);
      for (const p of stroke.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }, [doc, state.selectedIds, bitmaps, scale]);

  useEffect(() => {
    drawOverlay();
  }, [drawOverlay]);

  const toDoc = (e: React.PointerEvent): Point => {
    const rect = overlayRef.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * doc.width,
      y: ((e.clientY - rect.top) / rect.height) * doc.height,
    };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!e.isPrimary || downRef.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    downRef.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
    if (tool === "split") {
      strokeRef.current = [toDoc(e)];
      drawOverlay();
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (downRef.current?.id !== e.pointerId || tool !== "split" || !strokeRef.current) return;
    const p = toDoc(e);
    const last = strokeRef.current[strokeRef.current.length - 1]!;
    if (Math.hypot(p.x - last.x, p.y - last.y) < 1) return;
    strokeRef.current.push(p);
    drawOverlay();
  };

  const finish = (e: React.PointerEvent, cancelled: boolean) => {
    const down = downRef.current;
    if (!down || down.id !== e.pointerId) return;
    downRef.current = null;
    const stroke = strokeRef.current;
    strokeRef.current = null;
    if (cancelled) {
      drawOverlay();
      return;
    }

    if (tool === "select") {
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > TAP_SLOP) return;
      const p = toDoc(e);
      const hit = hitTestPart(doc, bitmaps, p.x, p.y);
      const modifier = e.shiftKey || e.ctrlKey || e.metaKey;
      if (hit) dispatch({ type: "select", id: hit.id, mode: multiSelect || modifier ? "toggle" : "replace" });
      // 何も無い所のタップは選択解除。複数選択モードでも解除する（タッチ操作では他に解除手段が無いため）。
      // 修飾キー付きのクリックは「追加」の意図なので解除しない
      else if (!modifier) dispatch({ type: "select", id: null });
      return;
    }

    // 分割
    drawOverlay();
    if (!stroke || stroke.length < 2) {
      onMessage("パーツを横切るように線を引いてください。");
      return;
    }
    const target = pickSplitTarget(doc, bitmaps, state.selectedIds, stroke);
    if (!target) {
      onMessage("線の下にパーツがありません。");
      return;
    }
    const result = splitLayer(bitmaps, target, stroke);
    if (!result.ok) {
      onMessage(result.reason);
      return;
    }
    dispatch(result.action);
    onMessage(result.message);
  };

  const style = { width: doc.width * scale, height: doc.height * scale };
  return (
    <div className="canvas-area" ref={areaRef}>
      <div className="canvas-stack" style={style}>
        <canvas ref={canvasRef} className="canvas" style={style} aria-label={`キャンバス ${doc.name}`} />
        <canvas
          ref={overlayRef}
          className={`canvas-overlay tool-${tool}`}
          style={style}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => finish(e, false)}
          onPointerCancel={(e) => finish(e, true)}
        />
      </div>
    </div>
  );
}
