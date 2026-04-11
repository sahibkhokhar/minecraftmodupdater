import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Config, Loader } from "./types.js";

const CONFIG_PATH = path.join(os.homedir(), ".modpackrc.json");
const DEFAULT_PACKS_DIR = path.resolve(process.cwd(), "packs");

let _config: Config | null = null;

export function loadConfig(): Config {
  if (_config) return _config;
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, "utf8");
      _config = JSON.parse(raw) as Config;
      return _config;
    }
  } catch {
    // fall through to defaults
  }
  _config = {};
  return _config;
}

export function saveConfig(updates: Partial<Config>): void {
  const current = loadConfig();
  const next = { ...current, ...updates };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), "utf8");
  _config = next;
}

export function getPacksDir(): string {
  return loadConfig().packsDir ?? DEFAULT_PACKS_DIR;
}

export function getDefaultLoader(): Loader | undefined {
  return loadConfig().defaultLoader;
}

export function getDefaultMcVersion(): string | undefined {
  return loadConfig().defaultMinecraftVersion;
}

export function getConcurrency(): number {
  return loadConfig().concurrency ?? 6;
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}
