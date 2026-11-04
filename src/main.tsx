import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { EditorProvider } from "./store/editorStore";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <EditorProvider>
      <App />
    </EditorProvider>
  </StrictMode>,
);

// オフライン用の Service Worker（本番ビルドのみ）。
// 埋め込み先（claude.ai の Artifact など）では使えず、navigator.serviceWorker の参照自体が例外になることがあるので握りつぶす
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    try {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    } catch {
      // 使えない環境では、オフライン対応なしで動かす
    }
  });
}
