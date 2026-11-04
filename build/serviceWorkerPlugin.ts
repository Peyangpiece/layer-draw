/// <reference types="node" />
/**
 * オフラインで使えるようにするための Service Worker をビルド時に生成する Vite プラグイン。
 *
 * 出力ディレクトリのファイルがすべて書き出された後（closeBundle）に一覧を作り、
 * 内容のハッシュをキャッシュ名に入れた sw.js を書き出す。内容が変わればキャッシュ名も変わるので、
 * ブラウザは新しい Service Worker を入れ直し、古いキャッシュを消す。
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Plugin, ResolvedConfig } from "vite";

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? listFiles(p) : [p];
  });
}

export function serviceWorkerPlugin(): Plugin {
  let config: ResolvedConfig;
  return {
    name: "layer-draw-service-worker",
    apply: "build",
    configResolved(c) {
      config = c;
    },
    closeBundle() {
      const outDir = config.build.outDir.startsWith("/") ? config.build.outDir : join(config.root, config.build.outDir);
      const files = listFiles(outDir)
        .map((f) => relative(outDir, f).split(sep).join("/"))
        .filter((f) => f !== "sw.js" && !f.endsWith(".map"))
        .sort();
      const hash = createHash("sha256");
      for (const f of files) hash.update(f).update(readFileSync(join(outDir, f)));
      const version = hash.digest("hex").slice(0, 12);
      const source = swSource(version, files);
      // 構文エラーのある sw.js は登録に失敗し、オフライン対応が黙って無効になるので、ビルドを失敗させる
      try {
        new Function(source);
      } catch (e) {
        throw new Error(`生成した sw.js に構文エラーがあります: ${(e as Error).message}`);
      }
      writeFileSync(join(outDir, "sw.js"), source);
    },
  };
}

function swSource(version: string, files: string[]): string {
  return `// 自動生成（build/serviceWorkerPlugin.ts）。編集しないこと
const CACHE = "layer-draw-${version}";
const FILES = ${JSON.stringify(["./", ...files.filter((f) => f !== "index.html")], null, 0)};

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(FILES.map((f) => new URL(f, self.registration.scope))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("layer-draw-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  if (req.mode === "navigate") {
    // ページ: オンラインなら常に最新、オフラインならキャッシュ
    event.respondWith(
      fetch(req).catch(() => fromOwnCache(new URL("./", self.registration.scope)).then((r) => r || Response.error())),
    );
    return;
  }
  // それ以外（ファイル名にハッシュが付くので中身は変わらない）: キャッシュ優先
  event.respondWith(fromOwnCache(req).then((hit) => hit || fetch(req)));
});

// この版のキャッシュだけを見る。caches.match() は全キャッシュを作成順に探すため、
// 更新の切り替え中に古い版のページを返してしまう
function fromOwnCache(req) {
  return caches.open(CACHE).then((cache) => cache.match(req));
}
`;
}
