import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const staticSrc = path.join(root, ".next", "static");
const staticDest = path.join(root, ".next", "standalone", ".next", "static");
const publicSrc = path.join(root, "public");
const publicDest = path.join(root, ".next", "standalone", "public");

if (fs.existsSync(staticSrc)) {
  fs.cpSync(staticSrc, staticDest, { recursive: true, force: true });
}
if (fs.existsSync(publicSrc)) {
  fs.cpSync(publicSrc, publicDest, { recursive: true, force: true });
}

// Prune bloated dependencies not needed at runtime by the standalone server
const standaloneNodeModules = path.join(root, ".next", "standalone", "node_modules");
const prunePackages = ["typescript", "@img", "sharp"];

for (const pkg of prunePackages) {
  const target = path.join(standaloneNodeModules, pkg);
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
    console.log(`✓ Pruned unneeded runtime dependency: ${pkg}`);
  }
}

// Remove source maps from standalone
function removeSourceMaps(dir) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      removeSourceMaps(fullPath);
    } else if (entry.name.endsWith(".map")) {
      fs.unlinkSync(fullPath);
    }
  }
}

removeSourceMaps(path.join(root, ".next", "standalone"));

console.log("✓ Standalone assets prepared and optimized successfully.");
