import fs from "node:fs";
import path from "node:path";
import { getPacksDir } from "../config.js";
import type { PackMeta, PackMod } from "../types.js";

export const META_FILENAME = "modpack.json";

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

export function sanitizeName(input: string): string {
  return input
    .replace(/[^a-zA-Z0-9\-_ ]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

export function packDirName(packName: string, mcVersion: string, loader: string): string {
  return `${packName}-${mcVersion}-${loader}`;
}

// ── Listing ───────────────────────────────────────────────────────────────────

export async function listPackDirs(): Promise<string[]> {
  const packsDir = getPacksDir();
  try {
    const entries = await fs.promises.readdir(packsDir);
    const valid: string[] = [];
    for (const name of entries) {
      const fullPath = path.join(packsDir, name);
      const metaPath = path.join(fullPath, META_FILENAME);
      if (fs.existsSync(metaPath)) valid.push(fullPath);
    }
    return valid;
  } catch {
    return [];
  }
}

// ── Read / Write ──────────────────────────────────────────────────────────────

export async function readPackMeta(packDir: string): Promise<PackMeta> {
  const stat = fs.statSync(packDir);
  const metaPath = stat.isDirectory()
    ? path.join(packDir, META_FILENAME)
    : packDir;
  const raw = await fs.promises.readFile(metaPath, "utf8");
  return JSON.parse(raw) as PackMeta;
}

export async function writePackMeta(packDir: string, meta: PackMeta): Promise<void> {
  const metaPath = path.join(packDir, META_FILENAME);
  await fs.promises.writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8");
}

// ── Mod file helpers ──────────────────────────────────────────────────────────

export function modsDir(packDir: string): string {
  return path.join(packDir, "mods");
}

export function modFilePath(packDir: string, fileName: string): string {
  return path.join(modsDir(packDir), fileName);
}

export function filterOutExisting(
  hits: Array<{ project_id: string; slug: string }>,
  existing: PackMod[]
): Array<{ project_id: string; slug: string }> {
  const ids = new Set(existing.map((m) => m.projectId));
  const slugs = new Set(existing.map((m) => m.slug));
  return hits.filter((h) => !ids.has(h.project_id) && !slugs.has(h.slug));
}

// ── Rename ────────────────────────────────────────────────────────────────────

export async function renamePack(
  packDir: string,
  newPackName: string
): Promise<string> {
  const meta = await readPackMeta(packDir);
  const sanitized = sanitizeName(newPackName);
  const newDirName = packDirName(sanitized, meta.minecraftVersion, meta.loader);
  const newPackDir = path.join(path.dirname(packDir), newDirName);

  await fs.promises.rename(packDir, newPackDir);

  const updated: PackMeta = {
    ...meta,
    packName: sanitized,
    updatedAt: new Date().toISOString(),
  };
  await writePackMeta(newPackDir, updated);

  return newPackDir;
}

// ── Remove mods ───────────────────────────────────────────────────────────────

export async function removeMods(
  packDir: string,
  indexes: number[]
): Promise<string[]> {
  const meta = await readPackMeta(packDir);
  const toRemove = new Set(indexes);
  const removed: string[] = [];
  const kept: PackMod[] = [];

  for (let i = 0; i < meta.mods.length; i++) {
    const mod = meta.mods[i];
    if (toRemove.has(i)) {
      const filePath = modFilePath(packDir, mod.fileName);
      try {
        await fs.promises.unlink(filePath);
      } catch {
        // file already gone, that's fine
      }
      removed.push(mod.title);
    } else {
      kept.push(mod);
    }
  }

  meta.mods = kept;
  meta.updatedAt = new Date().toISOString();
  await writePackMeta(packDir, meta);
  return removed;
}

// ── Add mod ───────────────────────────────────────────────────────────────────

export async function addModToMeta(
  packDir: string,
  mod: PackMod
): Promise<void> {
  const meta = await readPackMeta(packDir);
  meta.mods.push(mod);
  meta.updatedAt = new Date().toISOString();
  await writePackMeta(packDir, meta);
}
