import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { PackMeta } from "../types.js";
import { modsDir } from "./packManager.js";
import type { ServerPackTarget } from "../ui/prompts.js";

// ── CRC-32 ────────────────────────────────────────────────────────────────────

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

// ── ZIP writer (STORE for binaries, DEFLATE for text) ─────────────────────────

type ZipEntry = { name: string; data: Buffer; compress?: boolean };

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

  for (const { name, data, compress = false } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);

    let body: Buffer;
    let method: number;
    if (compress) {
      body = zlib.deflateRawSync(data, { level: 6 });
      method = 8; // DEFLATE
    } else {
      body = data;
      method = 0; // STORE
    }

    // Local file header
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);

    offsets.push(offset);
    localParts.push(local, body);
    offset += local.length + body.length;

    // Central directory entry
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offsets[offsets.length - 1], 42);
    nameBytes.copy(central, 46);
    centralParts.push(central);
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

// ── Bundled server files ───────────────────────────────────────────────────────

// Shared MeowIce G1GC flags that work on all platforms / JVMs (Java 21+, x86_64)
const MEOWICE_BASE = `\
--add-modules=jdk.incubator.vector
-XX:+UseG1GC
-XX:MaxGCPauseMillis=200
-XX:+UnlockExperimentalVMOptions
-XX:+UnlockDiagnosticVMOptions
-XX:+DisableExplicitGC
-XX:+AlwaysPreTouch
-XX:G1NewSizePercent=28
-XX:G1MaxNewSizePercent=50
-XX:G1HeapRegionSize=16M
-XX:G1ReservePercent=15
-XX:G1MixedGCCountTarget=3
-XX:InitiatingHeapOccupancyPercent=20
-XX:G1MixedGCLiveThresholdPercent=90
-XX:SurvivorRatio=32
-XX:G1HeapWastePercent=5
-XX:MaxTenuringThreshold=1
-XX:+PerfDisableSharedMem
-XX:G1SATBBufferEnqueueingThresholdPercent=30
-XX:G1ConcMarkStepDurationMillis=5
-XX:G1RSetUpdatingPauseTimePercent=0
-XX:+UseNUMA
-XX:-DontCompileHugeMethods
-XX:MaxNodeLimit=240000
-XX:NodeLimitFudgeFactor=8000
-XX:ReservedCodeCacheSize=400M
-XX:NonNMethodCodeHeapSize=12M
-XX:ProfiledCodeHeapSize=194M
-XX:NonProfiledCodeHeapSize=194M
-XX:NmethodSweepActivity=1
-XX:+SegmentedCodeCache
-XX:+EagerJVMCI
-XX:+UseFastUnorderedTimeStamps
-XX:+UseCriticalJavaThreadPriority
-XX:AllocatePrefetchStyle=3
-XX:+AlwaysActAsServerClassMachine
-XX:+UseStringDeduplication
-XX:+OmitStackTraceInFastThrow
-XX:+RewriteBytecodes
-XX:+RewriteFrequentPairs
-XX:+EliminateLocks
-XX:+DoEscapeAnalysis
-XX:+UseThreadPriorities
-XX:+UseInlineCaches
-XX:+UseFastJNIAccessors
-XX:+UseAES
-XX:+UseAESIntrinsics
-XX:+UseFMA
-XX:+UseLoopPredicate
-XX:+RangeCheckElimination
-XX:+OptimizeStringConcat
-XX:+UseCompressedOops
-XX:+UseFPUForSpilling
-XX:+AlignVector
-XX:+OptimizeFill
-XX:+EnableVectorSupport
-XX:+UseCharacterCompareIntrinsics
-XX:+UseCopySignIntrinsic
-XX:+UseVectorStubs
-XX:+UseVectorCmov
-XX:+UseFastStosb
-XX:+UseNewLongLShift
-XX:+UseXMMForArrayCopy
-XX:+UseXmmI2D
-XX:+UseXmmI2F
-XX:+UseXmmLoadAndClearUpper
-XX:+UseXmmRegToRegMoveAll
-XX:UseAVX=2
-XX:UseSSE=4
-Djdk.nio.maxCachedBufferSize=262144`;

const MEOWICE_LINUX_HUGEPAGES = `\
# ── Linux huge pages (better memory throughput) ───────────────────────────────
# Remove these 3 lines if the server crashes on startup.
-XX:+UseTransparentHugePages
-XX:LargePageSizeInBytes=2M
-XX:+UseLargePages`;

const MEOWICE_GRAALVM = `\
# ── GraalVM JIT — requires Oracle GraalVM JDK 24+ ────────────────────────────
-Djdk.graal.UsePriorityInlining=true
-Djdk.graal.Vectorization=true
-Djdk.graal.OptDuplication=true
-Djdk.graal.DetectInvertedLoopsAsCounted=true
-Djdk.graal.LoopInversion=true
-Djdk.graal.VectorizeHashes=true
-Djdk.graal.EnterprisePartialUnroll=true
-Djdk.graal.VectorizeSIMD=true
-Djdk.graal.StripMineNonCountedLoops=true
-Djdk.graal.SpeculativeGuardMovement=true
-Djdk.graal.TuneInlinerExploration=1
-Djdk.graal.LoopRotation=true
-Djdk.graal.CompilerConfiguration=enterprise`;

function makeUserJvmArgs(target: ServerPackTarget): string {
  const headers: Record<ServerPackTarget, string> = {
    "linux-graalvm": `# ── MeowIce Flags — GraalVM JDK 24+ · Linux x86_64 ─────────────────────────
# Source: https://github.com/MeowIce/meowice-flags
# Requires Oracle GraalVM JDK 24+: https://www.graalvm.org/downloads/
# On ARM64: remove the x86_64-specific flags (UseAVX, UseSSE, UseXmm*, UseFastStosb, etc.)`,
    "linux-openjdk": `# ── MeowIce Flags — OpenJDK 21+ · Linux x86_64 ──────────────────────────────
# Source: https://github.com/MeowIce/meowice-flags
# On ARM64: remove the x86_64-specific flags (UseAVX, UseSSE, UseXmm*, UseFastStosb, etc.)
# Upgrade to GraalVM JDK 24+ and switch to the linux-graalvm variant for ~20 MSPT more.`,
    "windows-openjdk": `# ── MeowIce Flags — OpenJDK 21+ · Windows x86_64 ────────────────────────────
# Source: https://github.com/MeowIce/meowice-flags
# On ARM64: remove the x86_64-specific flags (UseAVX, UseSSE, UseXmm*, UseFastStosb, etc.)
# UseTransparentHugePages / UseLargePages are Linux-only and are excluded here.`,
  };

  const ram = `\
# ── RAM — set Xms = Xmx so Java never resizes the heap mid-game ──────────────
# 6G suits a small-medium server. Raise to 8G+ for 10+ players.
-Xms6G
-Xmx6G`;

  const parts = [headers[target], "", ram, "", MEOWICE_BASE];

  if (target === "linux-graalvm" || target === "linux-openjdk") {
    parts.push("", MEOWICE_LINUX_HUGEPAGES);
  }

  if (target === "linux-graalvm") {
    parts.push("", MEOWICE_GRAALVM);
  }

  return parts.join("\n") + "\n";
}

function makeReadme(meta: PackMeta, modCount: number, missing: string[], target: ServerPackTarget): string {
  const missingNote = missing.length
    ? `\nNOTE: ${missing.length} mod file(s) were not found on disk and were excluded:\n${missing.map(m => `  - ${m}`).join("\n")}\nRun "Sync / download missing mods" in the mod updater CLI first.\n`
    : "";

  const javaStep: Record<ServerPackTarget, string> = {
    "linux-graalvm": `1. Install Oracle GraalVM JDK 24+ (required for the bundled JVM flags):
     https://www.graalvm.org/downloads/

     Quick install on Linux (adapt the version number to the latest):
       cd /usr/lib/jvm
       sudo wget https://download.oracle.com/graalvm/24/latest/graalvm-jdk-24_linux-x64_bin.tar.gz
       sudo tar -xzf graalvm-jdk-24_linux-x64_bin.tar.gz
       sudo rm graalvm-jdk-24_linux-x64_bin.tar.gz

     Then point your server manager / JAVA_HOME at the extracted folder.
     In Crafty Controller: after installing, restart Crafty and select
     the GraalVM entry in "Override current Java Version" on the server config page.

     If you cannot install GraalVM, delete the last section of user_jvm_args.txt
     (the -Djdk.graal.* lines) and use OpenJDK 21+ instead.`,

    "linux-openjdk": `1. Install OpenJDK 21+:
       sudo apt install openjdk-21-jdk   # Debian / Ubuntu
     Or from: https://adoptium.net/

     In Crafty Controller: select the java-21-openjdk entry in
     "Override current Java Version" on the server config page.`,

    "windows-openjdk": `1. Install OpenJDK 21+:
     https://adoptium.net/
     (Install with the "Add to PATH" option checked)`,
  };

  const startStep: Record<ServerPackTarget, string> = {
    "linux-graalvm": `5. Start the server:
     bash run.sh
   (run.sh is generated by the NeoForge installer and reads user_jvm_args.txt automatically)`,
    "linux-openjdk": `5. Start the server:
     bash run.sh`,
    "windows-openjdk": `5. Start the server:
     run.bat
   (run.bat is generated by the NeoForge installer and reads user_jvm_args.txt automatically)`,
  };

  const jvmNote: Record<ServerPackTarget, string> = {
    "linux-graalvm": `JVM FLAGS (user_jvm_args.txt)
------------------------------
MeowIce flags with GraalVM JIT enabled.  https://github.com/MeowIce/meowice-flags
Benchmarks show ~20 MSPT improvement over Aikar's flags under load.
Requires Oracle GraalVM JDK 24+. On ARM64 remove the x86_64-specific lines.`,
    "linux-openjdk": `JVM FLAGS (user_jvm_args.txt)
------------------------------
MeowIce flags (G1GC build) for OpenJDK 21+.  https://github.com/MeowIce/meowice-flags
Better G1GC tuning than Aikar's flags. For ~20 MSPT more, switch to GraalVM JDK 24+.
On ARM64 remove the x86_64-specific lines.`,
    "windows-openjdk": `JVM FLAGS (user_jvm_args.txt)
------------------------------
MeowIce flags (G1GC build) for OpenJDK 21+ on Windows.  https://github.com/MeowIce/meowice-flags
Linux-specific huge page flags are excluded. On ARM64 remove the x86_64-specific lines.`,
  };

  return `${meta.packName}
${"=".repeat(meta.packName.length)}
NeoForge server pack for Minecraft ${meta.minecraftVersion}
Target: ${target}
Generated: ${new Date().toISOString()}
Mods included: ${modCount}
${missingNote}
QUICK START
-----------
${javaStep[target]}

2. Download the NeoForge ${meta.minecraftVersion} installer:
     https://neoforged.net/

3. Place the installer JAR in this folder and run:
     java -jar neoforge-*-installer.jar --install-server
   This generates run.sh / run.bat and the libraries/ folder.

4. Edit user_jvm_args.txt to set your RAM (-Xms / -Xmx).
   Default is 6G. Raise to 8G+ for 10+ players.
   eula.txt is already included (eula=true).

${startStep[target]}

${jvmNote[target]}

FOLDER STRUCTURE
----------------
  mods/               <-- all mod JARs (already included)
  user_jvm_args.txt   <-- JVM flags (auto-read by run.sh / run.bat)
  eula.txt            <-- pre-accepted EULA
  README.txt          <-- this file
  run.sh / run.bat    <-- generated by NeoForge installer (step 3)

Do NOT start the server without completing steps 1-3 first.
`;
}

// ── Public API ────────────────────────────────────────────────────────────────

export type ServerPackResult = {
  modCount: number;
  missing: string[];
  outputPath: string;
  target: ServerPackTarget;
};

export async function exportToServerZip(
  meta: PackMeta,
  packDir: string,
  outputPath: string,
  target: ServerPackTarget,
  onProgress?: (done: number, total: number, name: string) => void
): Promise<ServerPackResult> {
  const mDir = modsDir(packDir);
  const entries: ZipEntry[] = [];
  const missing: string[] = [];

  const total = meta.mods.length;
  let done = 0;

  for (const mod of meta.mods) {
    const filePath = path.join(mDir, mod.fileName);
    if (fs.existsSync(filePath)) {
      const data = await fs.promises.readFile(filePath);
      // JARs are already ZIP-compressed — use STORE to avoid wasted CPU
      entries.push({ name: `mods/${mod.fileName}`, data, compress: false });
    } else {
      missing.push(mod.title);
    }
    done++;
    onProgress?.(done, total, mod.fileName);
  }

  const modCount = entries.length;

  // Text files use DEFLATE
  entries.push({ name: "user_jvm_args.txt", data: Buffer.from(makeUserJvmArgs(target)),                      compress: true });
  entries.push({ name: "README.txt",        data: Buffer.from(makeReadme(meta, modCount, missing, target)),   compress: true });
  entries.push({ name: "eula.txt",          data: Buffer.from("eula=true\n"),                                 compress: true });

  const zipBuf = buildZip(entries);
  await fs.promises.writeFile(outputPath, zipBuf);

  return { modCount, missing, outputPath, target };
}
