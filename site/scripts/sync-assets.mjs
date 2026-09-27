import { cp, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

const source = path.resolve(process.cwd(), "../docs/assets");
const target = path.resolve(process.cwd(), "src/assets/docs");

async function exists(directory) {
  try {
    await readdir(directory);
    return true;
  } catch {
    return false;
  }
}

await mkdir(target, { recursive: true });

if (!(await exists(source))) {
  console.error(`[sync-assets] ${source} does not exist.`);
  console.error("[sync-assets] Run this site from inside the pigeon-swarm repository: its images come from docs/assets.");
  process.exit(1);
}

await cp(source, target, {
  recursive: true,
  force: true,
});

console.log(`[sync-assets] copied ${source} -> ${target}`);
