import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_REVIEWED_ARCHIVE_BYTES = 64 * 1024 * 1024;
const READ_BUFFER_BYTES = 64 * 1024;

export async function verifyFileSri(path, expectedIntegrity) {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("Reviewed archive path is required");
  }
  if (
    typeof expectedIntegrity !== "string" ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(expectedIntegrity)
  ) {
    throw new Error("Reviewed archive SHA-512 integrity is invalid");
  }
  const pathMetadata = await lstat(path, { bigint: true });
  assertSafeArchive(pathMetadata);
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let operationFailed = false;
  let primaryError;
  try {
    const metadata = await handle.stat({ bigint: true });
    assertSafeArchive(metadata);
    assertSameIdentity(pathMetadata, metadata);
    const hash = createHash("sha512");
    const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
    let offset = 0;
    const size = Number(metadata.size);
    while (offset < size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, size - offset),
        offset,
      );
      if (bytesRead === 0) {
        throw new Error("Reviewed archive changed while being read");
      }
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const finalMetadata = await handle.stat({ bigint: true });
    assertSameIdentity(metadata, finalMetadata);
    const actualIntegrity = `sha512-${hash.digest("base64")}`;
    if (actualIntegrity !== expectedIntegrity) {
      throw new Error("Reviewed archive integrity mismatch");
    }
  } catch (error) {
    operationFailed = true;
    primaryError = error;
  }
  try {
    await handle.close();
  } catch (cleanupError) {
    if (operationFailed) {
      throw new AggregateError(
        [primaryError, cleanupError],
        "Reviewed archive verification and cleanup both failed",
        { cause: cleanupError },
      );
    }
    throw cleanupError;
  }
  if (operationFailed) throw primaryError;
}

function assertSafeArchive(metadata) {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    metadata.size < 1n ||
    metadata.size > BigInt(MAX_REVIEWED_ARCHIVE_BYTES)
  ) {
    throw new Error("Reviewed archive is not a safe regular file");
  }
}

function assertSameIdentity(first, second) {
  if (
    first.dev !== second.dev ||
    first.ino !== second.ino ||
    first.nlink !== second.nlink ||
    first.size !== second.size ||
    first.mtimeNs !== second.mtimeNs ||
    first.ctimeNs !== second.ctimeNs
  ) {
    throw new Error("Reviewed archive changed while being verified");
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  if (process.argv.length !== 4) {
    throw new Error("Usage: verify-file-sri.mjs <archive> <sha512-integrity>");
  }
  await verifyFileSri(process.argv[2], process.argv[3]);
}
