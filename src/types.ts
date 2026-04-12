export type Loader = "fabric" | "forge" | "neoforge" | "quilt";

export type ModrinthSearchHit = {
  project_id: string;
  slug: string;
  title: string;
  description: string;
  downloads: number;
  categories: string[];
};

export type ModrinthSearchResponse = {
  hits: ModrinthSearchHit[];
};

export type ModrinthVersionFile = {
  filename: string;
  primary: boolean;
  url: string;
  size?: number;
};

export type ModrinthDependency = {
  project_id: string | null;
  version_id: string | null;
  dependency_type: "required" | "optional" | "incompatible" | "embedded";
};

export type ModrinthProjectVersion = {
  id: string;
  name: string;
  version_number: string;
  date_published: string;
  files: ModrinthVersionFile[];
  game_versions: string[];
  loaders: string[];
  dependencies?: ModrinthDependency[];
};

export type ModrinthProject = {
  id: string;
  slug: string;
  title: string;
  description: string;
  downloads: number;
};

export type ModrinthGameVersion = {
  version: string;
  version_type: "release" | "snapshot" | "alpha" | "beta";
  date: string;
  major: boolean;
};

export type PackMod = {
  projectId: string;
  slug: string;
  title: string;
  versionId: string;
  versionNumber: string;
  fileName: string;
  downloadUrl: string;
};

export type PackMeta = {
  packName: string;
  minecraftVersion: string;
  loader: Loader;
  createdAt: string;
  updatedAt?: string;
  mods: PackMod[];
  source: "modrinth";
  incompatible?: Record<string, string>;
};

export type Config = {
  packsDir?: string;
  defaultLoader?: Loader;
  defaultMinecraftVersion?: string;
  concurrency?: number;
};

export type MrpackIndex = {
  formatVersion: number;
  game: string;
  name: string;
  versionId: string;
  summary?: string;
  dependencies: {
    minecraft: string;
    neoforge?: string;
    fabric?: string;
    forge?: string;
    "fabric-loader"?: string;
    "quilt-loader"?: string;
  };
  files: Array<{
    path: string;
    hashes: { sha1: string; sha512: string };
    env?: { client: string; server: string };
    downloads: string[];
    fileSize: number;
  }>;
};

export type DownloadResult = {
  ok: boolean;
  fileName: string;
  error?: string;
};
