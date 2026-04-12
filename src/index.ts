import path from "node:path";
import fs from "node:fs";
import prompts from "prompts";

// API
import {
  searchProjects,
  getLatestCompatibleVersion,
  getLatestCompatibleVersionBatch,
  getProject,
  selectPrimaryFile,
} from "./api/modrinth.js";

// Core
import {
  ensureDir,
  sanitizeName,
  packDirName,
  listPackDirs,
  readPackMeta,
  writePackMeta,
  modsDir,
  modFilePath,
  filterOutExisting,
  renamePack,
  removeMods,
  addModToMeta,
} from "./core/packManager.js";
import { downloadFile, downloadBatch } from "./core/downloader.js";
import { readMrpackIndex, extractProjectIdFromUrl, exportToMrpack } from "./core/mrpack.js";
import { findMissingDeps, installDep } from "./core/deps.js";

// Config
import {
  getPacksDir,
  getDefaultLoader,
  getDefaultMcVersion,
  getConcurrency,
  saveConfig,
  loadConfig,
  getConfigPath,
} from "./config.js";

// UI
import {
  printBanner,
  printSuccess,
  printError,
  printWarn,
  printInfo,
  printSectionHeader,
  printPackSummary,
  printModList,
  printModUpdateRow,
  printSearchHit,
  renderProgressBar,
  writeProgress,
  clearProgress,
  blank,
  separator,
  formatDownloads,
} from "./ui/display.js";
import { clr } from "./ui/colors.js";
import {
  BACK,
  mainMenu,
  settingsMenu,
  pickLoader,
  pickMinecraftVersion,
  pickPackName,
  pickPack,
  pickSearchResult,
  confirm,
  inputText,
  multiSelect,
} from "./ui/prompts.js";
import type { PackMeta, PackMod, Loader } from "./types.js";

// ── Graceful Ctrl+C ───────────────────────────────────────────────────────────

prompts.override({});
process.on("SIGINT", () => {
  clearProgress();
  console.log(clr.muted("\n  Cancelled."));
  process.exit(0);
});

// ── Create pack ───────────────────────────────────────────────────────────────

async function actionCreatePack(): Promise<void> {
  printSectionHeader("Create New Pack");

  const nameRaw = await pickPackName();
  if (nameRaw === BACK) return;
  const packName = sanitizeName(nameRaw);

  const loader = await pickLoader();
  if (loader === BACK) return;

  const mcVersion = await pickMinecraftVersion();
  if (mcVersion === BACK) return;

  const packDir = path.join(getPacksDir(), packDirName(packName, mcVersion, loader));
  await ensureDir(modsDir(packDir));

  const meta: PackMeta = {
    packName,
    minecraftVersion: mcVersion,
    loader,
    createdAt: new Date().toISOString(),
    mods: [],
    source: "modrinth",
  };

  await writePackMeta(packDir, meta);
  blank();
  printSuccess(`Pack created: ${clr.highlight(packName)} (${loader}, ${mcVersion})`);
  printInfo(`Location: ${clr.muted(packDir)}`);
  blank();

  // Immediately go into add-mods flow
  const addNow = await confirm("Start adding mods now?");
  if (addNow) {
    await searchAndAddMods(packDir, meta);
  }
}

// ── Search loop (shared by create + add-mods) ─────────────────────────────────

async function searchAndAddMods(
  packDir: string,
  meta: PackMeta
): Promise<void> {
  const { loader, minecraftVersion } = meta;

  while (true) {
    blank();
    const termRaw = await inputText(
      `Search mods  ${clr.muted("(empty to finish)")}`
    );
    if (termRaw === BACK || !termRaw.trim()) break;

    let hits;
    try {
      writeProgress(clr.muted("Searching..."));
      hits = await searchProjects(termRaw.trim(), minecraftVersion, loader);
      clearProgress();
    } catch (e) {
      clearProgress();
      printError(`Search failed: ${e}`);
      continue;
    }

    // Filter out already-added mods
    const existingIds = new Set([
      ...meta.mods.map((m) => m.projectId),
      ...meta.mods.map((m) => m.slug),
    ]);
    const filtered = hits.filter(
      (h) => !existingIds.has(h.project_id) && !existingIds.has(h.slug)
    );

    if (!filtered.length) {
      printWarn("No new results. All matches are already in this pack.");
      continue;
    }

    const chosen = await pickSearchResult(filtered, existingIds);
    if (!chosen || chosen === BACK) continue;

    // Fetch compatible version
    writeProgress(clr.muted(`Fetching version info for ${chosen.title}...`));
    const latest = await getLatestCompatibleVersion(
      chosen.project_id || chosen.slug,
      minecraftVersion,
      loader
    );
    clearProgress();

    if (!latest) {
      printWarn(`No compatible version for ${clr.bold(chosen.title)} on ${loader} ${minecraftVersion}.`);
      continue;
    }

    const file = selectPrimaryFile(latest.files);
    if (!file) {
      printWarn("No files found for this version.");
      continue;
    }

    // Download
    const dest = modFilePath(packDir, file.filename);
    writeProgress(`Downloading ${clr.bold(chosen.title)}...`);
    try {
      await downloadFile(file.url, dest);
      clearProgress();
    } catch (e) {
      clearProgress();
      printError(`Download failed: ${e}`);
      continue;
    }

    const mod: PackMod = {
      projectId: chosen.project_id,
      slug: chosen.slug,
      title: chosen.title,
      versionId: latest.id,
      versionNumber: latest.version_number,
      fileName: file.filename,
      downloadUrl: file.url,
    };

    await addModToMeta(packDir, mod);
    meta.mods.push(mod);
    printSuccess(`Added ${clr.bold(chosen.title)} @ ${clr.brightYellow(latest.version_number)}`);

    // Dependency resolution
    writeProgress(clr.muted("Checking dependencies..."));
    const missingDeps = await findMissingDeps(latest, meta.mods, minecraftVersion, loader);
    clearProgress();

    for (const dep of missingDeps) {
      blank();
      printInfo(
        `${clr.bold(chosen.title)} requires ${clr.brightYellow(dep.title)}`
      );
      const addDep = await confirm(`Add required dependency: ${dep.title}?`);
      if (addDep) {
        writeProgress(`Downloading ${dep.title}...`);
        try {
          const added = await installDep(dep, packDir, meta);
          clearProgress();
          for (const m of added) {
            printSuccess(`Added dependency: ${clr.bold(m.title)} @ ${clr.brightYellow(m.versionNumber)}`);
          }
        } catch (e) {
          clearProgress();
          printError(`Failed to install dependency ${dep.title}: ${e}`);
        }
      }
    }
  }
}

// ── Add mods to existing pack ─────────────────────────────────────────────────

async function actionAddMods(): Promise<void> {
  printSectionHeader("Add Mods to Pack");
  const dir = await pickPack("Select a pack");
  if (dir === BACK) return;

  let meta: PackMeta;
  try {
    meta = await readPackMeta(dir);
  } catch (e) {
    printError(`Could not read pack: ${e}`);
    return;
  }

  blank();
  printInfo(
    `${clr.highlight(meta.packName)}  ${clr.muted(`${meta.loader} · ${meta.minecraftVersion} · ${meta.mods.length} mods`)}`
  );
  await searchAndAddMods(dir, meta);
}

// ── Remove mods ───────────────────────────────────────────────────────────────

async function actionRemoveMods(): Promise<void> {
  printSectionHeader("Remove Mods");
  const dir = await pickPack("Select a pack");
  if (dir === BACK) return;

  const meta = await readPackMeta(dir);
  if (!meta.mods.length) {
    printWarn("This pack has no mods.");
    return;
  }

  const choices = meta.mods.map((m, i) => ({
    title: `${clr.brightCyan(m.title)}  ${clr.muted(`@ ${m.versionNumber}`)}`,
    value: i,
  }));

  const selected = await multiSelect("Select mods to remove  (space to toggle)", choices);
  if (selected === BACK || !selected.length) return;

  blank();
  printWarn(`About to remove ${selected.length} mod(s):`);
  for (const idx of selected) {
    console.log(`    ${clr.muted("–")} ${meta.mods[idx].title}`);
  }
  blank();

  const ok = await confirm("Confirm removal?", false);
  if (!ok) {
    printInfo("Cancelled.");
    return;
  }

  const removed = await removeMods(dir, selected as number[]);
  for (const title of removed) printSuccess(`Removed ${title}`);
}

// ── View pack ─────────────────────────────────────────────────────────────────

async function actionViewPack(): Promise<void> {
  printSectionHeader("View Pack");
  const dir = await pickPack("Select a pack to view");
  if (dir === BACK) return;

  const meta = await readPackMeta(dir);
  blank();
  printPackSummary(meta, dir);
  blank();
  printSectionHeader("Mods");
  printModList(meta.mods);

  if (meta.incompatible && Object.keys(meta.incompatible).length) {
    blank();
    printSectionHeader("Incompatible mods");
    for (const title of Object.values(meta.incompatible)) {
      console.log(`  ${clr.warn("⚠")} ${clr.muted(title)}`);
    }
  }
}

// ── Rename pack ───────────────────────────────────────────────────────────────

async function actionRenamePack(): Promise<void> {
  printSectionHeader("Rename Pack");
  const dir = await pickPack("Select a pack to rename");
  if (dir === BACK) return;

  const meta = await readPackMeta(dir);
  blank();
  printInfo(`Current name: ${clr.highlight(meta.packName)}`);

  const newName = await pickPackName(meta.packName);
  if (newName === BACK) return;

  const sanitized = sanitizeName(newName);
  if (sanitized === meta.packName) {
    printInfo("Name unchanged.");
    return;
  }

  try {
    const newDir = await renamePack(dir, newName);
    printSuccess(
      `Renamed to ${clr.highlight(sanitized)} → ${clr.muted(newDir)}`
    );
  } catch (e) {
    printError(`Rename failed: ${e}`);
  }
}

// ── Update pack (new MC version) ──────────────────────────────────────────────

async function actionUpdatePack(): Promise<void> {
  printSectionHeader("Update Pack to New MC Version");
  const dir = await pickPack("Select a pack to update");
  if (dir === BACK) return;

  const meta = await readPackMeta(dir);
  blank();
  printInfo(
    `${clr.highlight(meta.packName)}  ${clr.muted(`${meta.loader} · currently ${meta.minecraftVersion}`)}`
  );

  const newVersion = await pickMinecraftVersion();
  if (newVersion === BACK) return;

  if (newVersion === meta.minecraftVersion) {
    printWarn("Same version selected. No changes needed.");
    return;
  }

  // Compatibility check with progress
  blank();
  printInfo(`Checking ${meta.mods.length} mods for ${newVersion}...`);
  blank();

  const results = await getLatestCompatibleVersionBatch(
    meta.mods.map((m) => m.projectId || m.slug),
    newVersion,
    meta.loader,
    getConcurrency(),
    (done, total) => {
      writeProgress(renderProgressBar(done, total) + "  checking compatibility");
    }
  );
  clearProgress();

  const compatible: Array<{ mod: PackMod; version: NonNullable<ReturnType<typeof results.get>> }> = [];
  const incompatible: PackMod[] = [];

  for (const mod of meta.mods) {
    const ver = results.get(mod.projectId || mod.slug);
    if (ver) compatible.push({ mod, version: ver });
    else incompatible.push(mod);
  }

  blank();
  printInfo(`${clr.success(String(compatible.length))} compatible  ·  ${clr.error(String(incompatible.length))} incompatible`);

  if (incompatible.length) {
    blank();
    printWarn("Incompatible mods (will be skipped):");
    for (const m of incompatible) {
      console.log(`  ${clr.muted("–")} ${m.title}`);
    }
  }

  blank();
  const proceed = await confirm(
    incompatible.length
      ? `Proceed with ${compatible.length} compatible mods?`
      : `Download all ${compatible.length} mods for ${newVersion}?`
  );
  if (!proceed) return;

  const newDirName = packDirName(meta.packName, newVersion, meta.loader);
  const newPackDir = path.join(getPacksDir(), newDirName);
  const newModsDir = modsDir(newPackDir);
  await ensureDir(newModsDir);

  const nextMeta: PackMeta = {
    packName: meta.packName,
    loader: meta.loader,
    minecraftVersion: newVersion,
    createdAt: new Date().toISOString(),
    mods: [],
    source: "modrinth",
    incompatible: {},
  };

  blank();
  const items = compatible
    .map(({ mod, version }) => {
      const file = selectPrimaryFile(version.files);
      if (!file) return null;
      return { url: file.url, destPath: path.join(newModsDir, file.filename), label: mod.title };
    })
    .filter(Boolean) as Array<{ url: string; destPath: string; label: string }>;

  const dlResults = await downloadBatch(items, getConcurrency(), (done, total, result) => {
    writeProgress(renderProgressBar(done, total) + "  " + clr.muted(result.fileName));
  });
  clearProgress();

  // Build new mod entries
  let i = 0;
  for (const { mod, version } of compatible) {
    const file = selectPrimaryFile(version.files);
    if (!file) { i++; continue; }
    const res = dlResults[i++];
    if (!res || !res.ok) {
      printError(`Failed: ${mod.title}`);
      continue;
    }
    nextMeta.mods.push({
      projectId: mod.projectId,
      slug: mod.slug,
      title: mod.title,
      versionId: version.id,
      versionNumber: version.version_number,
      fileName: file.filename,
      downloadUrl: file.url,
    });
    printSuccess(`${clr.bold(mod.title)} @ ${clr.brightYellow(version.version_number)}`);
  }

  for (const m of incompatible) {
    nextMeta.incompatible![m.projectId] = m.title;
  }

  await writePackMeta(newPackDir, nextMeta);
  blank();
  printSuccess(
    `Pack saved: ${clr.highlight(nextMeta.packName)} (${newVersion})  →  ${clr.muted(newPackDir)}`
  );
}

// ── Check compatibility ───────────────────────────────────────────────────────

async function actionCheckCompatibility(): Promise<void> {
  printSectionHeader("Check Compatibility");
  const dir = await pickPack("Select a pack to check");
  if (dir === BACK) return;

  const meta = await readPackMeta(dir);
  blank();
  printInfo(`${clr.highlight(meta.packName)}  ${clr.muted(`${meta.loader} · ${meta.minecraftVersion}`)}`);

  const targetVersion = await pickMinecraftVersion(meta.minecraftVersion);
  if (targetVersion === BACK) return;

  blank();
  printInfo(`Checking ${meta.mods.length} mods for ${clr.brightYellow(targetVersion)}...`);
  blank();

  const results = await getLatestCompatibleVersionBatch(
    meta.mods.map((m) => m.projectId || m.slug),
    targetVersion,
    meta.loader,
    getConcurrency(),
    (done, total) => {
      writeProgress(renderProgressBar(done, total) + "  checking");
    }
  );
  clearProgress();

  const compatible: PackMod[] = [];
  const incompatible: PackMod[] = [];

  for (const mod of meta.mods) {
    const ver = results.get(mod.projectId || mod.slug);
    if (ver) compatible.push(mod);
    else incompatible.push(mod);
  }

  blank();
  separator();
  if (compatible.length) {
    console.log(`  ${clr.success("Compatible")} (${compatible.length}):`);
    for (const m of compatible) {
      const newVer = results.get(m.projectId || m.slug);
      console.log(`    ${clr.muted("✓")} ${m.title}  ${clr.muted("→")} ${clr.brightGreen(newVer!.version_number)}`);
    }
  }
  if (incompatible.length) {
    blank();
    console.log(`  ${clr.error("Incompatible")} (${incompatible.length}):`);
    for (const m of incompatible) {
      console.log(`    ${clr.muted("✗")} ${clr.muted(m.title)}`);
    }
  }
  blank();
  separator();
  printInfo(
    `${clr.success(String(compatible.length))} / ${meta.mods.length} mods are compatible with ${clr.brightYellow(targetVersion)}`
  );
}

// ── Check for mod updates ─────────────────────────────────────────────────────

async function actionCheckModUpdates(): Promise<void> {
  printSectionHeader("Check for Mod Updates");
  const dir = await pickPack("Select a pack");
  if (dir === BACK) return;

  const meta = await readPackMeta(dir);
  if (!meta.mods.length) {
    printWarn("This pack has no mods.");
    return;
  }

  blank();
  printInfo(
    `Checking ${meta.mods.length} mods for updates (${meta.loader} · ${meta.minecraftVersion})...`
  );
  blank();

  const results = await getLatestCompatibleVersionBatch(
    meta.mods.map((m) => m.projectId || m.slug),
    meta.minecraftVersion,
    meta.loader,
    getConcurrency(),
    (done, total) => {
      writeProgress(renderProgressBar(done, total) + "  fetching");
    }
  );
  clearProgress();

  const updates: Array<{ mod: PackMod; newVersion: string; newVersionId: string; newUrl: string; newFileName: string }> = [];
  const upToDate: PackMod[] = [];

  blank();
  separator();
  for (const mod of meta.mods) {
    const latest = results.get(mod.projectId || mod.slug);
    if (!latest) {
      printModUpdateRow(mod.title, mod.versionNumber, null);
      upToDate.push(mod);
      continue;
    }
    if (latest.id === mod.versionId) {
      printModUpdateRow(mod.title, mod.versionNumber, null);
      upToDate.push(mod);
    } else {
      printModUpdateRow(mod.title, mod.versionNumber, latest.version_number);
      const file = selectPrimaryFile(latest.files);
      if (file) {
        updates.push({
          mod,
          newVersion: latest.version_number,
          newVersionId: latest.id,
          newUrl: file.url,
          newFileName: file.filename,
        });
      }
    }
  }
  separator();

  if (!updates.length) {
    blank();
    printSuccess("All mods are up to date!");
    return;
  }

  blank();
  printInfo(`${clr.brightYellow(String(updates.length))} update(s) available.`);
  blank();

  const downloadAll = await confirm(`Download all ${updates.length} update(s)?`);
  if (!downloadAll) return;

  const modsPath = modsDir(dir);
  await ensureDir(modsPath);

  const items = updates.map((u) => ({
    url: u.newUrl,
    destPath: path.join(modsPath, u.newFileName),
    label: u.mod.title,
  }));

  blank();
  const dlResults = await downloadBatch(items, getConcurrency(), (done, total, result) => {
    writeProgress(renderProgressBar(done, total) + "  " + clr.muted(result.fileName));
  });
  clearProgress();

  // Update metadata + remove old files
  let i = 0;
  for (const update of updates) {
    const res = dlResults[i++];
    if (!res?.ok) {
      printError(`Failed to download update for ${update.mod.title}`);
      continue;
    }

    // Remove old file if filename changed
    if (update.mod.fileName !== update.newFileName) {
      try {
        await fs.promises.unlink(path.join(modsPath, update.mod.fileName));
      } catch {
        // already gone
      }
    }

    const modInMeta = meta.mods.find((m) => m.projectId === update.mod.projectId);
    if (modInMeta) {
      modInMeta.versionId = update.newVersionId;
      modInMeta.versionNumber = update.newVersion;
      modInMeta.fileName = update.newFileName;
      modInMeta.downloadUrl = update.newUrl;
    }

    printSuccess(`${clr.bold(update.mod.title)} ${clr.muted(update.mod.versionNumber)} → ${clr.brightGreen(update.newVersion)}`);
  }

  meta.updatedAt = new Date().toISOString();
  await writePackMeta(dir, meta);
  blank();
  printSuccess(`Pack metadata saved.`);
}

// ── Import .mrpack ────────────────────────────────────────────────────────────

async function actionImportMrpack(): Promise<void> {
  printSectionHeader("Import .mrpack File");

  const mrpackPathRaw = await inputText("Path to .mrpack file");
  if (mrpackPathRaw === BACK) return;
  const mrpackPath = mrpackPathRaw.trim();

  if (!fs.existsSync(mrpackPath)) {
    printError("File not found.");
    return;
  }

  let index;
  try {
    writeProgress(clr.muted("Reading .mrpack..."));
    index = await readMrpackIndex(mrpackPath);
    clearProgress();
  } catch (e) {
    clearProgress();
    printError(`Failed to read .mrpack: ${e}`);
    return;
  }

  blank();
  printInfo(`Source MC version: ${clr.brightYellow(index.dependencies.minecraft)}`);
  printInfo(`Mods in archive: ${clr.bold(String(index.files.length))}`);
  blank();

  const loader = await pickLoader();
  if (loader === BACK) return;

  const mcVersion = await pickMinecraftVersion(index.dependencies.minecraft);
  if (mcVersion === BACK) return;

  const nameRaw = await pickPackName();
  if (nameRaw === BACK) return;
  const packName = sanitizeName(nameRaw);

  // Extract project IDs
  const projectIds: string[] = [];
  for (const f of index.files) {
    const id = extractProjectIdFromUrl(f.downloads[0]);
    if (id) projectIds.push(id);
  }

  blank();
  printInfo(`Checking ${projectIds.length} mods for ${loader} ${mcVersion}...`);
  blank();

  const results = await getLatestCompatibleVersionBatch(
    projectIds,
    mcVersion,
    loader,
    getConcurrency(),
    (done, total) => {
      writeProgress(renderProgressBar(done, total) + "  checking compatibility");
    }
  );
  clearProgress();

  const compatible: Array<{ id: string; version: NonNullable<ReturnType<typeof results.get>> }> = [];
  const incompatible: string[] = [];

  for (const [id, ver] of results) {
    if (ver) compatible.push({ id, version: ver });
    else incompatible.push(id);
  }

  blank();
  printInfo(
    `${clr.success(String(compatible.length))} compatible  ·  ${clr.error(String(incompatible.length))} incompatible`
  );

  if (incompatible.length) {
    blank();
    printWarn("Incompatible/not found:");
    for (const id of incompatible) {
      const match = index.files.find(
        (f) => extractProjectIdFromUrl(f.downloads[0]) === id
      );
      console.log(`  ${clr.muted("–")} ${clr.muted(match?.path.split("/").pop() ?? id)}`);
    }
  }

  blank();
  const proceed = await confirm(`Download ${compatible.length} compatible mods?`);
  if (!proceed) return;

  const packDir = path.join(getPacksDir(), packDirName(packName, mcVersion, loader));
  const mDir = modsDir(packDir);
  await ensureDir(mDir);

  const meta: PackMeta = {
    packName,
    minecraftVersion: mcVersion,
    loader,
    createdAt: new Date().toISOString(),
    mods: [],
    source: "modrinth",
    incompatible: {},
  };

  const items = compatible
    .map(({ id, version }) => {
      const file = selectPrimaryFile(version.files);
      if (!file) return null;
      return { url: file.url, destPath: path.join(mDir, file.filename), label: id };
    })
    .filter(Boolean) as Array<{ url: string; destPath: string; label: string }>;

  blank();
  const dlResults = await downloadBatch(items, getConcurrency(), (done, total, result) => {
    writeProgress(renderProgressBar(done, total) + "  " + clr.muted(result.fileName));
  });
  clearProgress();

  let i = 0;
  for (const { id, version } of compatible) {
    const file = selectPrimaryFile(version.files);
    if (!file) { i++; continue; }
    const res = dlResults[i++];
    if (!res?.ok) {
      printError(`Failed: ${file.filename}`);
      continue;
    }
    const match = index.files.find(
      (f) => extractProjectIdFromUrl(f.downloads[0]) === id
    );
    const title = match?.path.split("/").pop()?.replace(/\.jar$/, "") ?? id;
    meta.mods.push({
      projectId: id,
      slug: id,
      title,
      versionId: version.id,
      versionNumber: version.version_number,
      fileName: file.filename,
      downloadUrl: file.url,
    });
    printSuccess(file.filename);
  }

  for (const id of incompatible) meta.incompatible![id] = id;

  await writePackMeta(packDir, meta);
  blank();
  printSuccess(
    `Imported ${meta.mods.length} mods → ${clr.muted(packDir)}`
  );
}

// ── Export .mrpack ────────────────────────────────────────────────────────────

async function actionExportMrpack(): Promise<void> {
  printSectionHeader("Export Pack to .mrpack");
  const dir = await pickPack("Select a pack to export");
  if (dir === BACK) return;

  const meta = await readPackMeta(dir);
  const defaultOutput = path.join(
    process.cwd(),
    `${meta.packName}-${meta.minecraftVersion}.mrpack`
  );

  blank();
  printInfo(`Pack: ${clr.highlight(meta.packName)}  (${meta.mods.length} mods)`);

  const outputRaw = await inputText(
    `Output path  ${clr.muted(`[${defaultOutput}]`)}`,
    defaultOutput
  );
  if (outputRaw === BACK) return;
  const outputPath = outputRaw.trim() || defaultOutput;

  try {
    writeProgress(clr.muted("Building .mrpack..."));
    await exportToMrpack(meta, outputPath);
    clearProgress();
    printSuccess(`Exported: ${clr.muted(outputPath)}`);
  } catch (e) {
    clearProgress();
    printError(`Export failed: ${e}`);
  }
}

// ── Search & preview ──────────────────────────────────────────────────────────

async function actionPreviewSearch(): Promise<void> {
  printSectionHeader("Search & Preview Mods");

  while (true) {
    blank();
    const term = await inputText(`Search  ${clr.muted("(empty to go back)")}`);
    if (term === BACK || !term.trim()) break;

    // Prompt for loader/version to filter by
    const loader = await pickLoader();
    if (loader === BACK) break;
    const mcVersion = await pickMinecraftVersion();
    if (mcVersion === BACK) break;

    let hits;
    try {
      writeProgress(clr.muted("Searching Modrinth..."));
      hits = await searchProjects(term.trim(), mcVersion, loader, 20);
      clearProgress();
    } catch (e) {
      clearProgress();
      printError(`Search failed: ${e}`);
      continue;
    }

    if (!hits.length) {
      printWarn("No results found.");
      continue;
    }

    blank();
    separator();
    hits.slice(0, 10).forEach((h, i) =>
      printSearchHit(i, h.title, h.downloads, h.description)
    );
    separator();
    printInfo(`Showing ${Math.min(hits.length, 10)} of ${hits.length} results`);
  }
}

// ── Settings ──────────────────────────────────────────────────────────────────

async function actionSettings(): Promise<void> {
  while (true) {
    const config = loadConfig();
    printSectionHeader("Settings");

    const packsDir = config.packsDir ?? clr.muted("./packs (default)");
    const loader = config.defaultLoader ?? clr.muted("none");
    const mcVer = config.defaultMinecraftVersion ?? clr.muted("none");
    const concurrency = config.concurrency ?? clr.muted("6 (default)");

    blank();
    console.log(`  ${clr.bold("Packs dir:")}    ${packsDir}`);
    console.log(`  ${clr.bold("Def. loader:")}  ${loader}`);
    console.log(`  ${clr.bold("Def. MC ver:")}  ${mcVer}`);
    console.log(`  ${clr.bold("Concurrency:")} ${concurrency}`);
    console.log(`  ${clr.bold("Config file:")} ${clr.muted(getConfigPath())}`);
    blank();

    const action = await settingsMenu();

    if (action === "back") break;

    if (action === "change-packs-dir") {
      const val = await inputText("New packs directory (absolute path)");
      if (val !== BACK && val.trim()) {
        saveConfig({ packsDir: val.trim() });
        printSuccess(`Packs dir set to: ${val.trim()}`);
      }
    } else if (action === "change-loader") {
      const l = await pickLoader();
      if (l !== BACK) {
        saveConfig({ defaultLoader: l });
        printSuccess(`Default loader set to: ${l}`);
      }
    } else if (action === "change-mc-version") {
      const v = await pickMinecraftVersion();
      if (v !== BACK) {
        saveConfig({ defaultMinecraftVersion: v });
        printSuccess(`Default MC version set to: ${v}`);
      }
    } else if (action === "change-concurrency") {
      const val = await inputText("Concurrent downloads (1–16)", String(config.concurrency ?? 6));
      if (val !== BACK) {
        const n = parseInt(val, 10);
        if (n >= 1 && n <= 16) {
          saveConfig({ concurrency: n });
          printSuccess(`Concurrency set to: ${n}`);
        } else {
          printError("Enter a number between 1 and 16.");
        }
      }
    }
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await ensureDir(getPacksDir());

  printBanner();

  while (true) {
    const action = await mainMenu();
    if (!action || action === "exit") break;

    blank();

    try {
      switch (action) {
        case "create":         await actionCreatePack();          break;
        case "import-mrpack":  await actionImportMrpack();        break;
        case "export-mrpack":  await actionExportMrpack();        break;
        case "add-mods":       await actionAddMods();             break;
        case "remove-mods":    await actionRemoveMods();          break;
        case "view":           await actionViewPack();            break;
        case "rename":         await actionRenamePack();          break;
        case "update":         await actionUpdatePack();          break;
        case "check":          await actionCheckCompatibility();  break;
        case "mod-updates":    await actionCheckModUpdates();     break;
        case "preview-search": await actionPreviewSearch();       break;
        case "settings":       await actionSettings();            break;
      }
    } catch (err) {
      clearProgress();
      printError(`Unexpected error: ${err}`);
    }

    blank();
  }

  console.log(clr.muted("\n  Goodbye!\n"));
}

main().catch((err) => {
  console.error(clr.error("\nFatal error:"), err);
  process.exit(1);
});
