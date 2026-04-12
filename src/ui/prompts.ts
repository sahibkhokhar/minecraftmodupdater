import prompts from "prompts";
import path from "node:path";
import fs from "node:fs";
import { listPackDirs, readPackMeta } from "../core/packManager.js";
import { getReleaseVersions } from "../api/modrinth.js";
import { getDefaultLoader, getDefaultMcVersion } from "../config.js";
import { clr } from "./colors.js";
import { formatDownloads } from "./display.js";
import type { Loader, ModrinthSearchHit } from "../types.js";

// Sentinel returned when user picks "Back" or cancels
export const BACK = "__back__" as const;
export type BackSignal = typeof BACK;

// ── Loader picker ─────────────────────────────────────────────────────────────

export async function pickLoader(
  defaultLoader?: Loader
): Promise<Loader | BackSignal> {
  const def = defaultLoader ?? getDefaultLoader();
  const { loader } = await prompts({
    type: "select",
    name: "loader",
    message: "Mod loader",
    initial: def ? ["fabric", "neoforge", "forge", "quilt"].indexOf(def) : 0,
    choices: [
      { title: clr.brightGreen("Fabric"), value: "fabric" },
      { title: clr.brightYellow("NeoForge"), value: "neoforge" },
      { title: clr.yellow("Forge"), value: "forge" },
      { title: clr.magenta("Quilt"), value: "quilt" },
      { title: clr.muted("← Back"), value: BACK },
    ],
  });
  return (loader as Loader | BackSignal) ?? BACK;
}

// ── MC version picker ─────────────────────────────────────────────────────────

let _releaseVersionCache: string[] | null = null;

export async function pickMinecraftVersion(
  defaultVersion?: string
): Promise<string | BackSignal> {
  const def = defaultVersion ?? getDefaultMcVersion() ?? "";

  if (!_releaseVersionCache) {
    _releaseVersionCache = await getReleaseVersions();
  }

  const versions = _releaseVersionCache.slice(0, 30); // show last 30 releases

  if (!versions.length) {
    // Fallback to manual input if API fails
    const { version } = await prompts({
      type: "text",
      name: "version",
      message: "Minecraft version",
      initial: def,
      validate: (v: string) =>
        v && /^\d+\.\d+(\.\d+)?$/.test(v) ? true : "Enter a version like 1.21.4",
    });
    return (version as string) || BACK;
  }

  const choices = versions.map((v) => ({ title: v, value: v }));
  choices.push({ title: clr.muted("Type manually..."), value: "__manual__" });
  choices.push({ title: clr.muted("← Back"), value: BACK });

  const initial = def ? Math.max(versions.indexOf(def), 0) : 0;
  const { version } = await prompts({
    type: "select",
    name: "version",
    message: "Minecraft version",
    initial,
    choices,
  });

  if (!version || version === BACK) return BACK;

  if (version === "__manual__") {
    const { manual } = await prompts({
      type: "text",
      name: "manual",
      message: "Minecraft version",
      initial: def,
      validate: (v: string) =>
        v && /^\d+\.\d+(\.\d+)?$/.test(v) ? true : "Enter a version like 1.21.4",
    });
    return (manual as string) || BACK;
  }

  return version as string;
}

// ── Pack name ─────────────────────────────────────────────────────────────────

export async function pickPackName(
  initial = ""
): Promise<string | BackSignal> {
  const { name } = await prompts({
    type: "text",
    name: "name",
    message: "Pack name",
    initial,
    validate: (v: string) =>
      v && v.trim().length >= 2 ? true : "Name must be at least 2 characters",
  });
  return name ? (name as string) : BACK;
}

// ── Pack selector ─────────────────────────────────────────────────────────────

export async function pickPack(
  message = "Select a pack"
): Promise<string | BackSignal> {
  const dirs = await listPackDirs();

  if (!dirs.length) {
    return BACK;
  }

  const choices = await Promise.all(
    dirs.map(async (dir) => {
      try {
        const meta = await readPackMeta(dir);
        const hint = `${meta.loader}  ${meta.minecraftVersion}  ${meta.mods.length} mods`;
        return {
          title: clr.brightCyan(meta.packName) + "  " + clr.muted(hint),
          value: dir,
        };
      } catch {
        return { title: path.basename(dir), value: dir };
      }
    })
  );

  choices.push({ title: clr.muted("Choose by path..."), value: "__custom__" });
  choices.push({ title: clr.muted("← Back"), value: BACK });

  const { dir } = await prompts({
    type: "select",
    name: "dir",
    message,
    choices,
  });

  if (!dir || dir === BACK) return BACK;

  if (dir === "__custom__") {
    const { p } = await prompts({
      type: "text",
      name: "p",
      message: "Path to pack folder",
      validate: (v: string) =>
        v && fs.existsSync(v.trim()) ? true : "Path not found",
    });
    if (!p) return BACK;
    const stat = fs.statSync(p.trim());
    return stat.isDirectory() ? p.trim() : path.dirname(p.trim());
  }

  return dir as string;
}

// ── Confirm prompt ────────────────────────────────────────────────────────────

export async function confirm(
  message: string,
  initial = true
): Promise<boolean> {
  const { ok } = await prompts({ type: "confirm", name: "ok", message, initial });
  return ok === true;
}

// ── Search result picker ──────────────────────────────────────────────────────

export async function pickSearchResult(
  hits: ModrinthSearchHit[],
  existingIds: Set<string>
): Promise<ModrinthSearchHit | BackSignal | null> {
  if (!hits.length) return null;

  const choices = hits.slice(0, 20).map((h) => {
    const alreadyAdded = existingIds.has(h.project_id) || existingIds.has(h.slug);
    const dl = clr.muted(`${formatDownloads(h.downloads)} dl`);
    const addedTag = alreadyAdded ? clr.muted(" [added]") : "";
    const desc = h.description
      ? "\n     " + clr.muted(h.description.slice(0, 90))
      : "";
    return {
      title: `${clr.bold(h.title)}  ${dl}${addedTag}${desc}`,
      value: h,
      disabled: alreadyAdded,
    };
  });

  choices.push({
    title: clr.muted("← Back to search"),
    value: BACK as unknown as ModrinthSearchHit,
    disabled: false,
  });

  const { hit } = await prompts({
    type: "select",
    name: "hit",
    message: "Select a mod",
    choices,
  });

  if (!hit) return BACK;
  if ((hit as unknown as string) === BACK) return BACK;
  return hit as ModrinthSearchHit;
}

// ── Text input ────────────────────────────────────────────────────────────────

export async function inputText(
  message: string,
  initial = ""
): Promise<string | BackSignal> {
  const { value } = await prompts({ type: "text", name: "value", message, initial });
  return value != null ? (value as string) : BACK;
}

// ── Multi-select ──────────────────────────────────────────────────────────────

export async function multiSelect<T>(
  message: string,
  choices: Array<{ title: string; value: T }>
): Promise<T[] | BackSignal> {
  const { selected } = await prompts({
    type: "multiselect",
    name: "selected",
    message,
    choices,
    instructions: clr.muted("  space to toggle · enter to confirm · a to select all"),
  });
  if (!selected) return BACK;
  return selected as T[];
}

// ── Server pack target picker ─────────────────────────────────────────────────

export type ServerPackTarget = "linux-graalvm" | "linux-openjdk" | "windows-openjdk";

export async function pickServerPackTarget(): Promise<ServerPackTarget | BackSignal> {
  const { target } = await prompts({
    type: "select",
    name: "target",
    message: "Target platform / JVM",
    choices: [
      {
        title: clr.brightGreen("  Linux  +  GraalVM JDK 24+") + clr.muted("  (recommended — best performance)"),
        value: "linux-graalvm",
      },
      {
        title: clr.cyan("  Linux  +  OpenJDK 21") + clr.muted("  (standard, no GraalVM needed)"),
        value: "linux-openjdk",
      },
      {
        title: clr.brightYellow("  Windows  +  OpenJDK 21") + clr.muted("  (no large-pages, no GraalVM)"),
        value: "windows-openjdk",
      },
      { title: clr.muted("  ← Back"), value: BACK },
    ],
  });
  return (target as ServerPackTarget | BackSignal) ?? BACK;
}

// ── Main menu ─────────────────────────────────────────────────────────────────

export type MainMenuAction =
  | "create"
  | "import-mrpack"
  | "export-mrpack"
  | "export-server"
  | "add-mods"
  | "remove-mods"
  | "view"
  | "update"
  | "check"
  | "rename"
  | "mod-updates"
  | "sync"
  | "preview-search"
  | "settings"
  | "exit";

export async function mainMenu(): Promise<MainMenuAction | null> {
  const { action } = await prompts({
    type: "select",
    name: "action",
    message: "What do you want to do?",
    choices: [
      { title: clr.brightGreen("  Create new pack"), value: "create" },
      { title: clr.brightCyan("  Import .mrpack file"), value: "import-mrpack" },
      { title: clr.cyan("  Export pack → .mrpack  ") + clr.muted("(Prism / ATLauncher)"), value: "export-mrpack" },
      { title: clr.cyan("  Export pack → server .zip"), value: "export-server" },
      { title: "  ─────────────────────", value: "__sep__", disabled: true },
      { title: "  Add mods to pack", value: "add-mods" },
      { title: "  Remove mods from pack", value: "remove-mods" },
      { title: "  View pack", value: "view" },
      { title: "  Rename pack", value: "rename" },
      { title: "  ─────────────────────", value: "__sep2__", disabled: true },
      { title: "  Update pack (new MC version)", value: "update" },
      { title: "  Check compatibility", value: "check" },
      { title: clr.brightYellow("  Check for mod updates"), value: "mod-updates" },
      { title: clr.brightMagenta("  Sync / download missing mods"), value: "sync" },
      { title: "  ─────────────────────", value: "__sep3__", disabled: true },
      { title: "  Search & preview mods", value: "preview-search" },
      { title: "  Settings", value: "settings" },
      { title: clr.muted("  Exit"), value: "exit" },
    ],
  });

  if (!action || action === "exit") return "exit";
  if (action.startsWith("__sep")) return null; // separator clicked, re-show
  return action as MainMenuAction;
}

// ── Settings menu ─────────────────────────────────────────────────────────────

export type SettingsAction =
  | "change-packs-dir"
  | "change-loader"
  | "change-mc-version"
  | "change-concurrency"
  | "back";

export async function settingsMenu(): Promise<SettingsAction> {
  const { action } = await prompts({
    type: "select",
    name: "action",
    message: "Settings",
    choices: [
      { title: "  Change packs directory", value: "change-packs-dir" },
      { title: "  Change default loader", value: "change-loader" },
      { title: "  Change default MC version", value: "change-mc-version" },
      { title: "  Change download concurrency", value: "change-concurrency" },
      { title: clr.muted("  ← Back"), value: "back" },
    ],
  });
  return (action as SettingsAction) ?? "back";
}
