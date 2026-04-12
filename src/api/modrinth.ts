import type {
  Loader,
  ModrinthGameVersion,
  ModrinthProject,
  ModrinthProjectVersion,
  ModrinthSearchHit,
  ModrinthSearchResponse,
} from "../types.js";

const USER_AGENT = "minecraft-mod-updater/0.2.0 (github.com/sahibkhokhar/minecraftmodupdater)";
const BASE = "https://api.modrinth.com/v2";

async function apiFetch<T>(url: string | URL): Promise<T> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) {
    throw new Error(`Modrinth API error ${res.status}: ${res.statusText} — ${url}`);
  }
  return res.json() as Promise<T>;
}

// ── Search ────────────────────────────────────────────────────────────────────

function buildFacets(minecraftVersion?: string, loader?: Loader): string {
  const facets: string[][] = [["project_type:mod"]];
  if (minecraftVersion) facets.push([`versions:${minecraftVersion}`]);
  if (loader) facets.push([`categories:${loader}`]);
  return JSON.stringify(facets);
}

export async function searchProjects(
  query: string,
  minecraftVersion: string,
  loader: Loader,
  limit = 50
): Promise<ModrinthSearchHit[]> {
  const url = new URL(`${BASE}/search`);
  url.searchParams.set("query", query);
  url.searchParams.set("facets", buildFacets(minecraftVersion, loader));
  url.searchParams.set("limit", String(limit));
  const data = await apiFetch<ModrinthSearchResponse>(url);
  return data.hits;
}

// ── Versions ──────────────────────────────────────────────────────────────────

export async function getLatestCompatibleVersion(
  projectIdOrSlug: string,
  minecraftVersion: string,
  loader: Loader
): Promise<ModrinthProjectVersion | null> {
  const url = new URL(`${BASE}/project/${encodeURIComponent(projectIdOrSlug)}/version`);
  url.searchParams.set("loaders", JSON.stringify([loader]));
  url.searchParams.set("game_versions", JSON.stringify([minecraftVersion]));
  const versions = await apiFetch<ModrinthProjectVersion[]>(url);
  if (!versions.length) return null;
  versions.sort(
    (a, b) => new Date(b.date_published).getTime() - new Date(a.date_published).getTime()
  );
  return versions[0];
}

export async function getLatestCompatibleVersionBatch(
  projectIds: string[],
  minecraftVersion: string,
  loader: Loader,
  concurrency = 6,
  onProgress?: (done: number, total: number) => void
): Promise<Map<string, ModrinthProjectVersion | null>> {
  const results = new Map<string, ModrinthProjectVersion | null>();
  let done = 0;

  const chunks: string[][] = [];
  for (let i = 0; i < projectIds.length; i += concurrency) {
    chunks.push(projectIds.slice(i, i + concurrency));
  }

  for (const chunk of chunks) {
    await Promise.all(
      chunk.map(async (id) => {
        try {
          const v = await getLatestCompatibleVersion(id, minecraftVersion, loader);
          results.set(id, v);
        } catch {
          results.set(id, null);
        } finally {
          done++;
          onProgress?.(done, projectIds.length);
        }
      })
    );
  }

  return results;
}

// ── Project ───────────────────────────────────────────────────────────────────

export async function getProject(
  projectIdOrSlug: string
): Promise<ModrinthProject | null> {
  try {
    return await apiFetch<ModrinthProject>(
      `${BASE}/project/${encodeURIComponent(projectIdOrSlug)}`
    );
  } catch {
    return null;
  }
}

export async function getProjectsBatch(
  ids: string[]
): Promise<Map<string, ModrinthProject>> {
  if (!ids.length) return new Map();
  const url = new URL(`${BASE}/projects`);
  url.searchParams.set("ids", JSON.stringify(ids));
  try {
    const projects = await apiFetch<ModrinthProject[]>(url);
    const map = new Map<string, ModrinthProject>();
    for (const p of projects) map.set(p.id, p);
    return map;
  } catch {
    return new Map();
  }
}

// ── Game versions ─────────────────────────────────────────────────────────────

let _gameVersionsCache: ModrinthGameVersion[] | null = null;

export async function getGameVersions(): Promise<ModrinthGameVersion[]> {
  if (_gameVersionsCache) return _gameVersionsCache;
  try {
    _gameVersionsCache = await apiFetch<ModrinthGameVersion[]>(
      `${BASE}/tag/game_version`
    );
    return _gameVersionsCache;
  } catch {
    return [];
  }
}

export async function getReleaseVersions(): Promise<string[]> {
  const all = await getGameVersions();
  return all
    .filter((v) => v.version_type === "release")
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .map((v) => v.version);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function selectPrimaryFile(
  files: ModrinthProjectVersion["files"]
): ModrinthProjectVersion["files"][0] | null {
  if (!files.length) return null;
  return files.find((f) => f.primary) ?? files[0];
}
