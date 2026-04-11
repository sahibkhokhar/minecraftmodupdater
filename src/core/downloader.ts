import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream";
import { promisify } from "node:util";
import { ensureDir } from "./packManager.js";
import type { DownloadResult } from "../types.js";

const streamPipeline = promisify(pipeline);
const USER_AGENT = "minecraft-mod-updater/0.2.0";

// ── Single file download with retry ──────────────────────────────────────────

export async function downloadFile(
  url: string,
  destPath: string,
  retries = 3
): Promise<void> {
  await ensureDir(path.dirname(destPath));

  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const fileStream = fs.createWriteStream(destPath);
      // @ts-ignore Node18+ ReadableStream → Node stream
      await streamPipeline(res.body, fileStream);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        // Exponential backoff: 1s, 2s, 4s
        await sleep(1000 * 2 ** (attempt - 1));
      }
    }
  }
  throw lastErr;
}

// ── Batch download with concurrency + progress callback ───────────────────────

export type BatchItem = {
  url: string;
  destPath: string;
  label: string;
};

export async function downloadBatch(
  items: BatchItem[],
  concurrency = 4,
  onProgress?: (done: number, total: number, latest: DownloadResult) => void
): Promise<DownloadResult[]> {
  const results: DownloadResult[] = [];
  let done = 0;

  const chunks: BatchItem[][] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    chunks.push(items.slice(i, i + concurrency));
  }

  for (const chunk of chunks) {
    const chunkResults = await Promise.all(
      chunk.map(async ({ url, destPath, label }): Promise<DownloadResult> => {
        const fileName = path.basename(destPath);
        try {
          await downloadFile(url, destPath);
          const result: DownloadResult = { ok: true, fileName };
          done++;
          onProgress?.(done, items.length, result);
          return result;
        } catch (err) {
          const result: DownloadResult = {
            ok: false,
            fileName,
            error: String(err),
          };
          done++;
          onProgress?.(done, items.length, result);
          return result;
        }
      })
    );
    results.push(...chunkResults);
  }

  return results;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
