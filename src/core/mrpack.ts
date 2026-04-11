import fs from "node:fs";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import type { MrpackIndex, PackMeta } from "../types.js";

// ── CRC-32 (needed for ZIP format) ────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ── Minimal ZIP writer ────────────────────────────────────────────────────────

type ZipEntry = { name: string; data: Buffer };

function buildZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  const offsets: number[] = [];
  let offset = 0;

  const now = new Date();
  const dosDate =
    (((now.getFullYear() - 1980) & 0x7f) << 9) |
    (((now.getMonth() + 1) & 0x0f) << 5) |
    (now.getDate() & 0x1f);
  const dosTime =
    ((now.getHours() & 0x1f) << 11) |
    ((now.getMinutes() & 0x3f) << 5) |
    (Math.floor(now.getSeconds() / 2) & 0x1f);

  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(data, { level: 6 });
    const crc = crc32(data);

    // Local file header (30 bytes + filename)
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0); // signature PK\x03\x04
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0, 6);           // general purpose bit flag
    local.writeUInt16LE(8, 8);           // compression method: DEFLATE
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    nameBytes.copy(local, 30);

    offsets.push(offset);
    localParts.push(local, compressed);
    offset += local.length + compressed.length;

    // Central directory header (46 bytes + filename)
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0); // signature PK\x01\x02
    central.writeUInt16LE(20, 4);          // version made by
    central.writeUInt16LE(20, 6);          // version needed
    central.writeUInt16LE(0, 8);           // flags
    central.writeUInt16LE(8, 10);          // compression
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra field length
    central.writeUInt16LE(0, 32); // file comment length
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal file attributes
    central.writeUInt32LE(0, 38); // external file attributes
    central.writeUInt32LE(offsets[offsets.length - 1], 42); // local header offset
    nameBytes.copy(central, 46);
    centralParts.push(central);
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(0, 4);                             // disk number
  eocd.writeUInt16LE(0, 6);                             // disk with central dir
  eocd.writeUInt16LE(entries.length, 8);                // entries on disk
  eocd.writeUInt16LE(entries.length, 10);               // total entries
  eocd.writeUInt32LE(centralDir.length, 12);            // central dir size
  eocd.writeUInt32LE(offset, 16);                       // central dir offset
  eocd.writeUInt16LE(0, 20);                            // comment length

  return Buffer.concat([...localParts, centralDir, eocd]);
}

// ── ZIP reader (for mrpack import) ───────────────────────────────────────────

function extractFileFromZip(buf: Buffer, targetName: string): string | null {
  let i = 0;
  while (i < buf.length - 4) {
    if (
      buf[i] === 0x50 &&
      buf[i + 1] === 0x4b &&
      buf[i + 2] === 0x03 &&
      buf[i + 3] === 0x04
    ) {
      const compression = buf.readUInt16LE(i + 8);
      const compressedSize = buf.readUInt32LE(i + 18);
      const fileNameLength = buf.readUInt16LE(i + 26);
      const extraFieldLength = buf.readUInt16LE(i + 28);
      const fileName = buf.subarray(i + 30, i + 30 + fileNameLength).toString("utf8");
      const dataStart = i + 30 + fileNameLength + extraFieldLength;
      const dataEnd = dataStart + compressedSize;

      if (fileName === targetName) {
        const compData = buf.subarray(dataStart, dataEnd);
        if (compression === 0) return compData.toString("utf8");
        if (compression === 8) return inflateRawSync(compData).toString("utf8");
        throw new Error(`Unsupported compression method: ${compression}`);
      }
      i = dataEnd;
    } else {
      i++;
    }
  }
  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function readMrpackIndex(mrpackPath: string): Promise<MrpackIndex> {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(mrpackPath);
    const chunks: Buffer[] = [];
    stream.on("data", (c: string | Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stream.on("error", reject);
    stream.on("end", () => {
      try {
        const buf = Buffer.concat(chunks);
        const json = extractFileFromZip(buf, "modrinth.index.json");
        if (!json) throw new Error("modrinth.index.json not found in .mrpack");
        resolve(JSON.parse(json) as MrpackIndex);
      } catch (e) {
        reject(e);
      }
    });
  });
}

export function extractProjectIdFromUrl(url: string): string | null {
  const m = url.match(/cdn\.modrinth\.com\/data\/([^/]+)\/versions\/([^/]+)\//);
  return m ? m[1] : null;
}

export async function exportToMrpack(
  meta: PackMeta,
  outputPath: string
): Promise<void> {
  // Determine loader dependency key
  let loaderKey: string;
  switch (meta.loader) {
    case "fabric":   loaderKey = "fabric-loader"; break;
    case "quilt":    loaderKey = "quilt-loader";  break;
    case "neoforge": loaderKey = "neoforge";      break;
    default:         loaderKey = "forge";
  }

  const index: MrpackIndex = {
    formatVersion: 1,
    game: "minecraft",
    name: meta.packName,
    versionId: meta.updatedAt?.slice(0, 10) ?? meta.createdAt.slice(0, 10),
    dependencies: {
      minecraft: meta.minecraftVersion,
      [loaderKey]: "unknown",
    },
    files: meta.mods.map((mod) => ({
      path: `mods/${mod.fileName}`,
      hashes: { sha1: "", sha512: "" },
      env: { client: "required", server: "optional" },
      downloads: [mod.downloadUrl],
      fileSize: 0,
    })),
  };

  const indexJson = Buffer.from(JSON.stringify(index, null, 2), "utf8");
  const zipBuf = buildZip([{ name: "modrinth.index.json", data: indexJson }]);
  await fs.promises.writeFile(outputPath, zipBuf);
}
