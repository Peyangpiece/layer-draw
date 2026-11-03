/// <reference lib="webworker" />
import { decompose } from "./pipeline";
import type { WorkerRequest, WorkerResponse } from "./types";

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  if (msg.type !== "decompose") return;
  const { jobId } = msg;
  const post = (r: WorkerResponse, transfer: Transferable[] = []) => self.postMessage(r, transfer);
  try {
    const result = decompose(msg.image, msg.params, (stage, ratio) =>
      post({ type: "progress", jobId, stage, ratio }),
    );
    const transfer: Transferable[] = [result.lineart.data.buffer, ...result.parts.map((p) => p.image.data.buffer)];
    post({ type: "done", jobId, result }, transfer);
  } catch (e) {
    post({ type: "error", jobId, message: e instanceof Error ? e.message : String(e) });
  }
};
