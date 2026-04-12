import { getLatestCompatibleVersion, getProject, selectPrimaryFile } from "../api/modrinth.js";
import { downloadFile } from "./downloader.js";
import { addModToMeta, modsDir, modFilePath } from "./packManager.js";
import type { Loader, ModrinthProjectVersion, PackMeta, PackMod } from "../types.js";

export type PendingDep = {
  projectId: string;
  title: string;
  version: ModrinthProjectVersion;
};

/**
 * Given a just-resolved mod version, return all required dependencies
 * that are not already in the pack.
 */
export async function findMissingDeps(
  version: ModrinthProjectVersion,
  existingMods: PackMod[],
  minecraftVersion: string,
  loader: Loader
): Promise<PendingDep[]> {
  const deps = (version.dependencies ?? []).filter(
    (d) => d.dependency_type === "required" && d.project_id
  );

  if (!deps.length) return [];

  const existingIds = new Set(existingMods.map((m) => m.projectId));
  const missing: PendingDep[] = [];

  await Promise.all(
    deps.map(async (dep) => {
      const id = dep.project_id!;
      if (existingIds.has(id)) return;

      const [project, latestVer] = await Promise.all([
        getProject(id),
        getLatestCompatibleVersion(id, minecraftVersion, loader),
      ]);

      if (!project || !latestVer) return;

      missing.push({
        projectId: id,
        title: project.title,
        version: latestVer,
      });
    })
  );

  return missing;
}

/**
 * Download and add a single dependency (and recursively resolve its deps).
 * Returns the added mods (for display). Caller is responsible for prompting.
 */
export async function installDep(
  dep: PendingDep,
  packDir: string,
  meta: PackMeta,
  maxDepth = 3,
  _depth = 0
): Promise<PackMod[]> {
  const file = selectPrimaryFile(dep.version.files);
  if (!file) return [];

  const dest = modFilePath(packDir, file.filename);
  await downloadFile(file.url, dest);

  const mod: PackMod = {
    projectId: dep.projectId,
    slug: dep.projectId,
    title: dep.title,
    versionId: dep.version.id,
    versionNumber: dep.version.version_number,
    fileName: file.filename,
    downloadUrl: file.url,
  };

  await addModToMeta(packDir, mod);
  meta.mods.push(mod); // keep local copy in sync

  const added: PackMod[] = [mod];

  // Recursively resolve this dep's own required dependencies
  if (_depth < maxDepth) {
    const nested = await findMissingDeps(
      dep.version,
      meta.mods,
      meta.minecraftVersion,
      meta.loader
    );
    for (const nestedDep of nested) {
      const nestedAdded = await installDep(
        nestedDep,
        packDir,
        meta,
        maxDepth,
        _depth + 1
      );
      added.push(...nestedAdded);
    }
  }

  return added;
}
