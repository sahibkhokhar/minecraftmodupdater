import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream";
import { promisify } from "node:util";
import prompts from "prompts";

const streamPipeline = promisify(pipeline);

type Loader = "fabric" | "forge" | "neoforge" | "quilt";

type ModrinthSearchHit = {
  project_id: string;
  slug: string;
  title: string;
  description: string;
  downloads: number;
};

type ModrinthSearchResponse = {
  hits: ModrinthSearchHit[];
};

type ModrinthVersionFile = {
  filename: string;
  primary: boolean;
  url: string;
};

type ModrinthProjectVersion = {
  id: string;
  name: string;
  version_number: string;
  date_published: string;
  files: ModrinthVersionFile[];
  game_versions: string[];
  loaders: string[];
};

type PackMod = {
  projectId: string;
  slug: string;
  title: string;
  versionId: string;
  versionNumber: string;
  fileName: string;
  downloadUrl: string;
};

type PackMeta = {
  packName: string;
  minecraftVersion: string;
  loader: Loader;
  createdAt: string;
  mods: PackMod[];
  source: "modrinth";
  incompatible?: { [projectId: string]: string };
};

const ROOT_PACKS_DIR = path.resolve(process.cwd(), "packs");
const META_FILENAME = "modpack.json";

async function ensureDir(dirPath: string): Promise<void> {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

function sanitizeName(input: string): string {
  return input.replace(/[^a-zA-Z0-9-_ ]/g, "").trim().replace(/\s+/g, "-");
}

function buildFacetsQuery(minecraftVersion?: string, loader?: Loader): string | undefined {
  const facets: string[][] = [["project_type:mod"]];
  if (minecraftVersion) facets.push([`versions:${minecraftVersion}`]);
  if (loader) facets.push([`categories:${loader}`]);
  if (facets.length === 0) return undefined;
  // IMPORTANT: Return raw JSON string. URLSearchParams will handle encoding.
  return JSON.stringify(facets);
}

async function searchProjects(query: string, minecraftVersion: string, loader: Loader): Promise<ModrinthSearchHit[]> {
  const facets = buildFacetsQuery(minecraftVersion, loader);
  const url = new URL("https://api.modrinth.com/v2/search");
  url.searchParams.set("query", query);
  if (facets) url.searchParams.set("facets", facets);
  url.searchParams.set("limit", "50");

  const res = await fetch(url, { headers: { "User-Agent": "minecraft-mod-updater/0.1.0" } });
  if (!res.ok) throw new Error(`Search failed: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as ModrinthSearchResponse;
  return data.hits;
}

async function getLatestCompatibleVersion(projectIdOrSlug: string, minecraftVersion: string, loader: Loader): Promise<ModrinthProjectVersion | null> {
  const base = `https://api.modrinth.com/v2/project/${encodeURIComponent(projectIdOrSlug)}/version`;
  const params = new URLSearchParams();
  params.set("loaders", JSON.stringify([loader]));
  params.set("game_versions", JSON.stringify([minecraftVersion]));
  const url = `${base}?${params.toString()}`;
  const res = await fetch(url, { headers: { "User-Agent": "minecraft-mod-updater/0.1.0" } });
  if (!res.ok) throw new Error(`Version fetch failed: ${res.status} ${res.statusText}`);
  const versions = (await res.json()) as ModrinthProjectVersion[];
  if (!versions.length) return null;
  versions.sort((a, b) => new Date(b.date_published).getTime() - new Date(a.date_published).getTime());
  return versions[0];
}

async function downloadFile(url: string, destPath: string): Promise<void> {
  const res = await fetch(url, { headers: { "User-Agent": "minecraft-mod-updater/0.1.0" } });
  if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  await ensureDir(path.dirname(destPath));
  const fileStream = fs.createWriteStream(destPath);
  // @ts-ignore Node18 ReadableStream to Node stream
  await streamPipeline(res.body, fileStream);
}

function selectPrimaryFile(files: ModrinthVersionFile[]): ModrinthVersionFile | null {
  if (!files.length) return null;
  const primary = files.find(f => f.primary);
  return primary ?? files[0];
}

async function promptLoader(): Promise<Loader> {
  const { loader } = await prompts({
    type: "select",
    name: "loader",
    message: "Select mod loader",
    choices: [
      { title: "Fabric", value: "fabric" },
      { title: "NeoForge", value: "neoforge" },
      { title: "Forge", value: "forge" },
      { title: "Quilt", value: "quilt" }
    ]
  });
  return loader as Loader;
}

async function promptMinecraftVersion(defaultVersion?: string): Promise<string> {
  const { version } = await prompts({
    type: "text",
    name: "version",
    message: "Minecraft version (e.g. 1.20.1)",
    initial: defaultVersion ?? "",
    validate: (v: string) => (v && /^\d+\.\d+(\.\d+)?$/.test(v) ? true : "Enter like 1.20.1")
  });
  return version as string;
}

async function promptPackName(): Promise<string> {
  const { name } = await prompts({
    type: "text",
    name: "name",
    message: "Pack name",
    validate: (v: string) => (v && v.trim().length >= 2 ? true : "Enter a name")
  });
  return name as string;
}

async function chooseFromList<T extends { title: string }>(items: T[], emptyMessage: string): Promise<T | null> {
  if (!items.length) {
    console.log(emptyMessage);
    return null;
  }
  const options: Array<{ title: string; value: number }> = items.map((it, idx) => ({ title: it.title, value: idx }));
  const { index } = await prompts({ type: "select", name: "index", message: "Select", choices: options });
  if (index === undefined || index === null) return null;
  return items[index];
}

function filterOutExisting(hits: ModrinthSearchHit[], existing: { projectId: string; slug: string }[]): ModrinthSearchHit[] {
  const existingIds = new Set(existing.map(e => e.projectId).filter(Boolean));
  const existingSlugs = new Set(existing.map(e => e.slug).filter(Boolean));
  return hits.filter(h => !existingIds.has(h.project_id) && !existingSlugs.has(h.slug));
}

async function createPack(): Promise<void> {
  const packNameRaw = await promptPackName();
  const packName = sanitizeName(packNameRaw);
  const loader = await promptLoader();
  const mcVersion = await promptMinecraftVersion();

  const packDir = path.join(ROOT_PACKS_DIR, `${packName}-${mcVersion}-${loader}`);
  const modsDir = path.join(packDir, "mods");
  await ensureDir(modsDir);

  const meta: PackMeta = {
    packName,
    minecraftVersion: mcVersion,
    loader,
    createdAt: new Date().toISOString(),
    mods: [],
    source: "modrinth"
  };

  console.log(`\nAdding mods for ${packName} (${loader}, ${mcVersion}).`);
  while (true) {
    const { term } = await prompts({ type: "text", name: "term", message: "Search mods (blank to finish)", initial: "" });
    if (!term || !term.trim()) break;
    let hits: ModrinthSearchHit[] = [];
    try {
      hits = await searchProjects(term.trim(), mcVersion, loader);
    } catch (e) {
      console.error(String(e));
      continue;
    }
    // Remove already-added mods from results
    hits = filterOutExisting(hits, meta.mods.map(m => ({ projectId: m.projectId, slug: m.slug })));
    const top = hits.slice(0, 15).map(h => ({
      ...h,
      title: `${h.title}  —  ${h.downloads.toLocaleString()} downloads\n${h.description?.slice(0, 120) || ""}`
    }));
    const chosen = await chooseFromList(top, "No results (or all are already in this pack).");
    if (!chosen) continue;

    const latest = await getLatestCompatibleVersion(chosen.project_id || chosen.slug, mcVersion, loader);
    if (!latest) {
      console.log("No compatible version for this mod.");
      continue;
    }
    const file = selectPrimaryFile(latest.files);
    if (!file) {
      console.log("No files found for this version.");
      continue;
    }
    const destPath = path.join(modsDir, file.filename);
    console.log(`Downloading ${file.filename}...`);
    try {
      await downloadFile(file.url, destPath);
    } catch (e) {
      console.error("Download failed:", e);
      continue;
    }
    meta.mods.push({
      projectId: chosen.project_id,
      slug: chosen.slug,
      title: chosen.title.split("  —  ")[0],
      versionId: latest.id,
      versionNumber: latest.version_number,
      fileName: file.filename,
      downloadUrl: file.url
    });
    console.log(`Added ${chosen.title.split("  —  ")[0]} @ ${latest.version_number}`);
  }

  await fs.promises.writeFile(path.join(packDir, META_FILENAME), JSON.stringify(meta, null, 2), "utf8");
  console.log(`\nSaved pack at: ${packDir}`);
}

async function listExistingPacks(): Promise<string[]> {
  try {
    const names = await fs.promises.readdir(ROOT_PACKS_DIR);
    const valid: string[] = [];
    for (const n of names) {
      const p = path.join(ROOT_PACKS_DIR, n, META_FILENAME);
      if (fs.existsSync(p)) valid.push(path.join(ROOT_PACKS_DIR, n));
    }
    return valid;
  } catch {
    return [];
  }
}

async function pickPackDir(promptText = "Select a pack"): Promise<string | null> {
  const packs = await listExistingPacks();
  const choices = packs.map((dir) => ({ title: path.basename(dir), value: dir }));
  choices.push({ title: "Choose by path...", value: "__custom__" });
  const { dir } = await prompts({ type: "select", name: "dir", message: promptText, choices });
  if (!dir) return null;
  if (dir === "__custom__") {
    const { p } = await prompts({ type: "text", name: "p", message: "Path to pack folder or modpack.json" });
    if (!p) return null;
    const statPath = fs.statSync(p).isDirectory() ? p : path.dirname(p);
    return statPath;
  }
  return dir as string;
}

async function readPackMeta(packDir: string): Promise<PackMeta> {
  const metaPath = fs.statSync(packDir).isDirectory() ? path.join(packDir, META_FILENAME) : packDir;
  const raw = await fs.promises.readFile(metaPath, "utf8");
  return JSON.parse(raw) as PackMeta;
}

async function viewPack(): Promise<void> {
  const dir = await pickPackDir("Select a pack to view");
  if (!dir) return;
  const meta = await readPackMeta(dir);
  console.log(`\nPack: ${meta.packName}\nLoader: ${meta.loader}\nMinecraft: ${meta.minecraftVersion}\nMods:`);
  if (!meta.mods.length) {
    console.log("(no mods)");
    return;
  }
  for (const m of meta.mods) {
    console.log(`- ${m.title} @ ${m.versionNumber} (${m.fileName})`);
  }
}

async function updatePack(): Promise<void> {
  const currentDir = await pickPackDir("Select a pack to update");
  if (!currentDir) return;
  const current = await readPackMeta(currentDir);
  console.log(`\nUpdating: ${current.packName} (${current.loader}, ${current.minecraftVersion})`);
  const newVersion = await promptMinecraftVersion();

  const nextMeta: PackMeta = {
    packName: current.packName,
    loader: current.loader,
    minecraftVersion: newVersion,
    createdAt: new Date().toISOString(),
    mods: [],
    source: "modrinth",
    incompatible: {}
  };

  const compatResults: Array<{ mod: PackMod; latest: ModrinthProjectVersion | null }> = [];
  for (const mod of current.mods) {
    const latest = await getLatestCompatibleVersion(mod.projectId || mod.slug, newVersion, current.loader);
    compatResults.push({ mod, latest });
  }

  const incompatible = compatResults.filter(r => !r.latest);
  if (incompatible.length) {
    console.log("\nIncompatible mods for target version:");
    for (const r of incompatible) console.log(`- ${r.mod.title}`);
  } else {
    console.log("\nAll mods compatible.");
  }

  const { proceed } = await prompts({
    type: "confirm",
    name: "proceed",
    message: incompatible.length ? "Proceed without incompatible mods?" : "Proceed to create updated pack?",
    initial: true
  });
  if (!proceed) return;

  const newDirName = `${current.packName}-${newVersion}-${current.loader}`;
  const newPackDir = path.join(ROOT_PACKS_DIR, newDirName);
  const modsDir = path.join(newPackDir, "mods");
  await ensureDir(modsDir);

  for (const r of compatResults) {
    if (!r.latest) {
      nextMeta.incompatible![r.mod.projectId] = r.mod.title;
      continue;
    }
    const file = selectPrimaryFile(r.latest.files);
    if (!file) continue;
    const destPath = path.join(modsDir, file.filename);
    console.log(`Downloading ${r.mod.title} @ ${r.latest.version_number}...`);
    await downloadFile(file.url, destPath);
    nextMeta.mods.push({
      projectId: r.mod.projectId,
      slug: r.mod.slug,
      title: r.mod.title,
      versionId: r.latest.id,
      versionNumber: r.latest.version_number,
      fileName: file.filename,
      downloadUrl: file.url
    });
  }

  await fs.promises.writeFile(path.join(newPackDir, META_FILENAME), JSON.stringify(nextMeta, null, 2), "utf8");
  console.log(`\nSaved updated pack at: ${newPackDir}`);
}

async function checkCompatibility(): Promise<void> {
  const currentDir = await pickPackDir("Select a pack to check");
  if (!currentDir) return;
  const current = await readPackMeta(currentDir);
  console.log(`\nChecking: ${current.packName} (${current.loader}, ${current.minecraftVersion})`);
  const targetVersion = await promptMinecraftVersion();

  const results: Array<{ mod: PackMod; latest: ModrinthProjectVersion | null }> = [];
  for (const mod of current.mods) {
    const latest = await getLatestCompatibleVersion(mod.projectId || mod.slug, targetVersion, current.loader);
    results.push({ mod, latest });
  }

  const compatible = results.filter(r => !!r.latest);
  const incompatible = results.filter(r => !r.latest);

  console.log(`\nTarget: ${targetVersion} (${current.loader})`);
  if (compatible.length) {
    console.log("\nCompatible:");
    for (const r of compatible) {
      const latest = r.latest!;
      console.log(`- ${r.mod.title} → ${latest.version_number}`);
    }
  } else {
    console.log("\nCompatible: (none)");
  }

  if (incompatible.length) {
    console.log("\nIncompatible:");
    for (const r of incompatible) console.log(`- ${r.mod.title}`);
  } else {
    console.log("\nIncompatible: (none)");
  }

  console.log(`\nSummary: ${compatible.length} compatible, ${incompatible.length} incompatible, total ${results.length}.`);
}

async function addModsToPack(): Promise<void> {
  const dir = await pickPackDir("Select a pack to add mods to");
  if (!dir) return;
  const meta = await readPackMeta(dir);
  const modsDir = path.join(dir, "mods");
  await ensureDir(modsDir);

  console.log(`\nAdding mods to ${meta.packName} (${meta.loader}, ${meta.minecraftVersion}).`);
  while (true) {
    const { term } = await prompts({ type: "text", name: "term", message: "Search mods (blank to finish)", initial: "" });
    if (!term || !term.trim()) break;
    let hits: ModrinthSearchHit[] = [];
    try {
      hits = await searchProjects(term.trim(), meta.minecraftVersion, meta.loader);
    } catch (e) {
      console.error(String(e));
      continue;
    }
    // Exclude already present mods
    hits = filterOutExisting(hits, meta.mods.map(m => ({ projectId: m.projectId, slug: m.slug })));
    const top = hits.slice(0, 15).map(h => ({
      ...h,
      title: `${h.title}  —  ${h.downloads.toLocaleString()} downloads\n${h.description?.slice(0, 120) || ""}`
    }));
    const chosen = await chooseFromList(top, "No results (or all are already in this pack).");
    if (!chosen) continue;

    const latest = await getLatestCompatibleVersion(chosen.project_id || chosen.slug, meta.minecraftVersion, meta.loader);
    if (!latest) {
      console.log("No compatible version for this mod.");
      continue;
    }
    const file = selectPrimaryFile(latest.files);
    if (!file) {
      console.log("No files found for this version.");
      continue;
    }
    const destPath = path.join(modsDir, file.filename);
    console.log(`Downloading ${file.filename}...`);
    try {
      await downloadFile(file.url, destPath);
    } catch (e) {
      console.error("Download failed:", e);
      continue;
    }
    meta.mods.push({
      projectId: chosen.project_id,
      slug: chosen.slug,
      title: chosen.title.split("  —  ")[0],
      versionId: latest.id,
      versionNumber: latest.version_number,
      fileName: file.filename,
      downloadUrl: file.url
    });
    // Save after each add
    await fs.promises.writeFile(path.join(dir, META_FILENAME), JSON.stringify(meta, null, 2), "utf8");
    console.log(`Added ${chosen.title.split("  —  ")[0]} @ ${latest.version_number}`);
  }
}

async function main(): Promise<void> {
  await ensureDir(ROOT_PACKS_DIR);
  const { action } = await prompts({
    type: "select",
    name: "action",
    message: "What do you want to do?",
    choices: [
      { title: "Create new pack", value: "create" },
      { title: "Add mods to existing pack", value: "add-mods" },
      { title: "View existing pack", value: "view" },
      { title: "Update existing pack", value: "update" },
      { title: "Check compatibility (no download)", value: "check" },
      { title: "Exit", value: "exit" }
    ]
  });
  if (action === "create") {
    await createPack();
  } else if (action === "add-mods") {
    await addModsToPack();
  } else if (action === "view") {
    await viewPack();
  } else if (action === "update") {
    await updatePack();
  } else if (action === "check") {
    await checkCompatibility();
  }
}

// Run
main().catch((err) => {
  console.error(err);
  process.exit(1);
});


