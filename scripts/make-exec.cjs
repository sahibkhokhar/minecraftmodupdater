#!/usr/bin/env node
/**
 * Post-build script: takes the compiled entry point from dist/ and writes
 * a self-contained executable script with a shebang line to bin/.
 */

const fs = require("fs");
const path = require("path");

const DIST_ENTRY = path.resolve(__dirname, "../dist/index.js");
const BIN_DIR = path.resolve(__dirname, "../bin");
const BIN_OUT = path.join(BIN_DIR, "modpack");

if (!fs.existsSync(DIST_ENTRY)) {
  console.error(`[make-exec] dist/index.js not found. Run 'tsc' first.`);
  process.exit(1);
}

if (!fs.existsSync(BIN_DIR)) {
  fs.mkdirSync(BIN_DIR, { recursive: true });
}

const src = fs.readFileSync(DIST_ENTRY, "utf8");

// Prepend shebang if not already present
const shebang = "#!/usr/bin/env node\n";
const out = src.startsWith("#!") ? src : shebang + src;

fs.writeFileSync(BIN_OUT, out, "utf8");

// Make executable on Unix systems
try {
  fs.chmodSync(BIN_OUT, 0o755);
} catch {
  // Windows – chmod not applicable, that's fine
}

console.log(`[make-exec] Executable written to: ${BIN_OUT}`);
