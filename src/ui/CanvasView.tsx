import { useEffect, useMemo, useRef } from "react";
import type { LayerDocument } from "../core/types";
import { Canvas2DCompositor } from "../render/compositor";
import { useEditor } from "../store/editorStore";

/** ドキュメントを合成して表示する。表示倍率は CSS でコンテナに収める（ズーム・パンは今後実装）。 */
export function CanvasView({ doc }: { doc: LayerDocument }) {
  const { bitmaps } = useEditor();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const compositor = useMemo(() => new Canvas2DCompositor(bitmaps), [bitmaps]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const raf = requestAnimationFrame(() => compositor.render(doc, c));
    return () => cancelAnimationFrame(raf);
  }, [doc, compositor]);

  return (
    <div className="canvas-area">
      <canvas ref={canvasRef} className="canvas" aria-label={`キャンバス ${doc.name}`} />
    </div>
  );
}
