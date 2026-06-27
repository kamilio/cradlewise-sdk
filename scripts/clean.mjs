import { lstat, readdir, rm, unlink } from "node:fs/promises";

const requested = process.argv.slice(2);
for (const entry of requested) {
  if (
    entry !== "dist" &&
    entry !== "coverage" &&
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/.test(entry)
  ) {
    throw new Error(`Refusing to remove unsupported path: ${entry}`);
  }
}
const generated = requested.length > 0 ? requested : ["dist", "coverage"];
if (requested.length === 0) {
  for (const entry of await readdir(".")) {
    if (entry.endsWith(".tgz")) generated.push(entry);
  }
}
await Promise.all(generated.map(preflightGenerated));
await Promise.all(generated.map(removeGenerated));

/** @param {string} entry */
async function preflightGenerated(entry) {
  if (!entry.endsWith(".tgz")) return;
  try {
    const metadata = await lstat(entry);
    if (metadata.isDirectory()) {
      throw new Error(`Refusing to remove archive-named directory: ${entry}`);
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

/** @param {string} entry */
async function removeGenerated(entry) {
  if (entry.endsWith(".tgz")) {
    try {
      await unlink(entry);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
    return;
  }
  await rm(entry, { force: true, recursive: true });
}
