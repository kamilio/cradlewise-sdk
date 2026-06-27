import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

const cliPath = "dist/cli.js";
const pathMetadata = await lstat(cliPath);
if (
  !pathMetadata.isFile() ||
  pathMetadata.isSymbolicLink() ||
  pathMetadata.nlink !== 1
) {
  throw new Error(`${cliPath} is not a safe regular file`);
}
const handle = await open(
  cliPath,
  constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
);
try {
  const metadata = await handle.stat();
  if (
    !metadata.isFile() ||
    metadata.nlink !== 1 ||
    metadata.dev !== pathMetadata.dev ||
    metadata.ino !== pathMetadata.ino
  ) {
    throw new Error(`${cliPath} changed during validation`);
  }
  await handle.chmod(0o755);
} finally {
  await handle.close();
}
