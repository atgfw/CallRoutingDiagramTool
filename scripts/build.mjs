import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(root, "..");
const src = join(projectRoot, "src");
const dist = join(projectRoot, "dist");

// Keep the dist directory so OneDrive doesn't lock it during rebuilds.
await mkdir(dist, { recursive: true });
await cp(src, dist, { recursive: true, force: true });

console.log("Built static site into dist/");
