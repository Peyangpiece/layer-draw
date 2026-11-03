/**
 * 自動分解の処理時間計測（仕様書 5.7）。`npm run bench` で実行。
 * 合成した線画（円と格子を多数配置）を使う。Node 上の計測であり、実機ブラウザの値ではない。
 */
import { it } from "vitest";
import { decompose } from "../src/decompose/pipeline";
import { Sketch } from "../src/decompose/testImages";
import { DEFAULT_DECOMPOSE_PARAMS } from "../src/decompose/types";

function makeLineart(size: number): Sketch {
  const s = new Sketch(size, size);
  const t = Math.max(2, Math.round(size / 512)); // 線幅は解像度に比例
  let seed = 1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let i = 0; i < 40; i++) s.strokeCircle(rnd() * size, rnd() * size, (0.03 + rnd() * 0.15) * size, t);
  for (let k = 1; k < 8; k++) s.fillRect(Math.round((k * size) / 8), 0, t, size);
  return s;
}

for (const size of [1024, 2048, 4096]) {
  it(`${size}x${size}`, () => {
    const img = makeLineart(size).image();
    const runs = size >= 4096 ? 1 : 3;
    let best = Infinity, last: ReturnType<typeof decompose> | null = null;
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      last = decompose(img, DEFAULT_DECOMPOSE_PARAMS);
      best = Math.min(best, performance.now() - t0);
    }
    const st = Object.entries(last!.timings).map(([k, v]) => `${k}=${v.toFixed(0)}ms`).join(" ");
    console.log(`${size}x${size}: total(best of ${runs})=${best.toFixed(0)}ms parts=${last!.parts.length} [${st}]`);
  });
}
