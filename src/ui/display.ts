import { clr, stripAnsi } from "./colors.js";
import type { PackMeta, PackMod } from "../types.js";

const VERSION = "0.2.0";

// ── Banner ────────────────────────────────────────────────────────────────────

export function printBanner(): void {
  const title = "  Minecraft Mod Updater";
  const ver = `v${VERSION}`;
  const line = "─".repeat(32);
  console.log();
  console.log(clr.bold(clr.brightGreen(title)) + "  " + clr.muted(ver));
  console.log(clr.muted(line));
  console.log();
}

// ── Status messages ───────────────────────────────────────────────────────────

export function printSuccess(msg: string): void {
  console.log(clr.success("  ✓ ") + msg);
}

export function printError(msg: string): void {
  console.log(clr.error("  ✗ ") + msg);
}

export function printWarn(msg: string): void {
  console.log(clr.warn("  ⚠ ") + msg);
}

export function printInfo(msg: string): void {
  console.log(clr.info("  → ") + msg);
}

export function printSectionHeader(title: string): void {
  console.log();
  console.log(clr.bold(clr.brightCyan(`  ${title}`)));
  console.log(clr.muted("  " + "─".repeat(Math.max(title.length + 2, 28))));
}

// ── Progress bar ─────────────────────────────────────────────────────────────

export function renderProgressBar(
  current: number,
  total: number,
  width = 28
): string {
  const pct = total > 0 ? Math.min(current / total, 1) : 0;
  const filled = Math.round(pct * width);
  const empty = width - filled;
  const bar = clr.brightGreen("█".repeat(filled)) + clr.muted("░".repeat(empty));
  const pctStr = `${Math.round(pct * 100)}`.padStart(3);
  return `[${bar}] ${clr.bold(pctStr + "%")} ${clr.muted(`(${current}/${total})`)}`;
}

/** Write progress text on the same line (overwriting). */
export function writeProgress(msg: string): void {
  if (process.stdout.isTTY) {
    // Clear to end of line after the message
    process.stdout.write(`\r  ${msg}\x1b[K`);
  } else {
    console.log(msg);
  }
}

/** Clear the current inline progress line. */
export function clearProgress(): void {
  if (process.stdout.isTTY) {
    process.stdout.write("\r\x1b[K");
  }
}

// ── Pack display ──────────────────────────────────────────────────────────────

export function printPackSummary(meta: PackMeta, dir: string): void {
  printSectionHeader("Pack Info");
  console.log(`  ${clr.bold("Name:")}    ${clr.highlight(meta.packName)}`);
  console.log(`  ${clr.bold("Loader:")}  ${clr.brightYellow(meta.loader)}`);
  console.log(`  ${clr.bold("MC:")}      ${clr.brightYellow(meta.minecraftVersion)}`);
  console.log(`  ${clr.bold("Mods:")}    ${meta.mods.length}`);
  console.log(`  ${clr.bold("Dir:")}     ${clr.muted(dir)}`);
  if (meta.updatedAt) {
    console.log(`  ${clr.bold("Updated:")} ${clr.muted(meta.updatedAt.slice(0, 10))}`);
  }
}

export function printModList(mods: PackMod[]): void {
  if (!mods.length) {
    console.log(clr.muted("  (no mods)"));
    return;
  }
  const maxTitle = Math.min(Math.max(...mods.map(m => m.title.length)), 36);
  for (const m of mods) {
    const title = m.title.padEnd(maxTitle).slice(0, maxTitle);
    const ver = clr.muted(`@ ${m.versionNumber}`);
    const file = clr.muted(`  ${m.fileName}`);
    console.log(`  ${clr.brightCyan(title)}  ${ver}${file}`);
  }
}

export function printModUpdateRow(
  title: string,
  current: string,
  latest: string | null
): void {
  const titlePad = title.slice(0, 32).padEnd(32);
  if (!latest || latest === current) {
    console.log(
      `  ${clr.muted(titlePad)}  ${clr.muted(current.padEnd(12))}  ${clr.success("up to date")}`
    );
  } else {
    console.log(
      `  ${clr.bold(titlePad)}  ${clr.muted(current.padEnd(12))}  ${clr.brightYellow("→")}  ${clr.brightGreen(latest)}`
    );
  }
}

export function printSearchHit(
  index: number,
  title: string,
  downloads: number,
  description: string
): void {
  const num = clr.muted(`${index + 1}.`.padStart(3));
  const dl = clr.muted(`${formatDownloads(downloads)} dl`);
  const desc = description
    ? clr.muted("     " + description.slice(0, 100))
    : "";
  console.log(`  ${num} ${clr.bold(clr.brightCyan(title))}  ${dl}`);
  if (desc) console.log(desc);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function formatDownloads(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

export function separator(width = 40): void {
  console.log(clr.muted("  " + "─".repeat(width)));
}

export function blank(): void {
  console.log();
}
