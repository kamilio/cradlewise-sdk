import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import {
  readZipEntries,
  readZipEntryBytes,
  streamZipEntry,
  throwZipCleanupFailures,
  writeZipEntryToFile,
} from "../src/zip-utils.js";

const MAX_ARCHIVE = 16 * 1024 * 1024;
const fixtureDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtureDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("streaming ZIP utilities", () => {
  it("retains ZIP operation and cleanup failures", () => {
    const cleanupError = new Error("cleanup failed");
    expect(() =>
      throwZipCleanupFailures(
        true,
        undefined,
        [null, cleanupError],
        "ZIP cleanup failed",
      ),
    ).toThrow(
      expect.objectContaining({
        message: "ZIP cleanup failed",
        errors: [undefined, null, cleanupError],
        cause: undefined,
      }),
    );

    let rejected = false;
    try {
      throwZipCleanupFailures(false, undefined, [undefined], "unused");
    } catch (error) {
      rejected = true;
      expect(error).toBeUndefined();
    }
    expect(rejected).toBe(true);
    expect(() =>
      throwZipCleanupFailures(false, undefined, [], "unused"),
    ).not.toThrow();
  });

  it("reads, streams, and writes stored and deflated entries", async () => {
    const directory = await privateDirectory();
    const archive = join(directory, "archive.zip");
    const largeStored = new Uint8Array(1_100_123);
    for (let index = 0; index < largeStored.byteLength; index += 1)
      largeStored[index] = index % 251;
    await writeFile(
      archive,
      zipSync(
        {
          "stored.txt": [strToU8("stored"), { level: 0 }],
          "large-stored.bin": [largeStored, { level: 0 }],
          "deflated.txt": [strToU8("deflated ".repeat(1000)), { level: 6 }],
          "empty.txt": new Uint8Array(),
        },
        { level: 6 },
      ),
      { mode: 0o600 },
    );
    const entries = await readZipEntries(archive, MAX_ARCHIVE, 10);
    expect(entries.map(({ name }) => name)).toEqual([
      "stored.txt",
      "large-stored.bin",
      "deflated.txt",
      "empty.txt",
    ]);
    const stored = entries[0]!;
    const large = entries[1]!;
    const deflated = entries[2]!;
    const empty = entries[3]!;
    await expect(readZipEntryBytes(archive, stored, 100)).resolves.toEqual(
      strToU8("stored"),
    );
    await expect(readZipEntryBytes(archive, empty, 0)).resolves.toEqual(
      new Uint8Array(),
    );
    await expect(
      readZipEntryBytes(archive, large, largeStored.byteLength),
    ).resolves.toEqual(largeStored);
    const chunks: Uint8Array[] = [];
    for await (const chunk of streamZipEntry(archive, deflated))
      chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe("deflated ".repeat(1000));
    const destination = join(directory, "output.txt");
    await writeZipEntryToFile(archive, deflated, destination, 20_000);
    await expect(readFile(destination, "utf8")).resolves.toBe(
      "deflated ".repeat(1000),
    );
    await expect(
      writeZipEntryToFile(archive, deflated, destination, 20_000),
    ).rejects.toMatchObject({ code: "EEXIST" });
    await expect(readZipEntryBytes(archive, deflated, 1)).rejects.toThrow(
      /size limit/,
    );
    await expect(
      writeZipEntryToFile(archive, deflated, join(directory, "too-large"), 1),
    ).rejects.toThrow(/size limit/);
  });

  it("rejects unsafe archive files and missing end records", async () => {
    const directory = await privateDirectory();
    const tiny = join(directory, "tiny.zip");
    await writeFile(tiny, "not a zip", { mode: 0o600 });
    await expect(readZipEntries(tiny, MAX_ARCHIVE, 10)).rejects.toThrow(
      /safe bounded regular file/,
    );
    const missing = join(directory, "missing.zip");
    await writeFile(missing, new Uint8Array(30), { mode: 0o600 });
    await expect(readZipEntries(missing, MAX_ARCHIVE, 10)).rejects.toThrow(
      /end-of-central-directory/,
    );
    const linked = join(directory, "linked.zip");
    await link(missing, linked);
    await expect(readZipEntries(linked, MAX_ARCHIVE, 10)).rejects.toThrow(
      /safe bounded regular file/,
    );
    const symlinked = join(directory, "symlink.zip");
    await symlink(missing, symlinked);
    await expect(
      readZipEntries(symlinked, MAX_ARCHIVE, 10),
    ).rejects.toBeDefined();
    const subdirectory = join(directory, "folder.zip");
    await mkdir(subdirectory);
    await expect(readZipEntries(subdirectory, MAX_ARCHIVE, 10)).rejects.toThrow(
      /safe bounded regular file/,
    );
  });

  it("rejects unsupported end and central-directory metadata", async () => {
    const directory = await privateDirectory();
    const base = zipSync({ "file.txt": strToU8("hello") });
    const cases: Array<[string, (bytes: Buffer) => void, RegExp]> = [
      [
        "disk",
        (bytes) => writeU16(bytes, endOffset(bytes) + 4, 1),
        /Multi-disk/,
      ],
      [
        "central-disk",
        (bytes) => writeU16(bytes, endOffset(bytes) + 6, 1),
        /Multi-disk/,
      ],
      [
        "count-mismatch",
        (bytes) => writeU16(bytes, endOffset(bytes) + 8, 0),
        /Multi-disk/,
      ],
      [
        "zip64-count",
        (bytes) => writeU16(bytes, endOffset(bytes) + 10, 0xffff),
        /ZIP64/,
      ],
      [
        "too-many",
        (bytes) => {
          writeU16(bytes, endOffset(bytes) + 8, 2);
          writeU16(bytes, endOffset(bytes) + 10, 2);
        },
        /too many entries/,
      ],
      [
        "central-size",
        (bytes) => writeU32(bytes, endOffset(bytes) + 12, 33 * 1024 * 1024),
        /central directory exceeds/,
      ],
      [
        "central-offset",
        (bytes) => writeU32(bytes, endOffset(bytes) + 16, bytes.length),
        /out of bounds/,
      ],
      [
        "central-signature",
        (bytes) => writeU32(bytes, centralOffset(bytes), 0),
        /signature/,
      ],
      [
        "encrypted",
        (bytes) => writeU16(bytes, centralOffset(bytes) + 8, 1),
        /Encrypted/,
      ],
      [
        "zip64-size",
        (bytes) => writeU32(bytes, centralOffset(bytes) + 20, 0xffffffff),
        /ZIP64/,
      ],
      [
        "disk-start",
        (bytes) => writeU16(bytes, centralOffset(bytes) + 34, 1),
        /Multi-disk/,
      ],
      [
        "empty-name",
        (bytes) => writeU16(bytes, centralOffset(bytes) + 28, 0),
        /name is invalid/,
      ],
      [
        "local-offset",
        (bytes) =>
          writeU32(bytes, centralOffset(bytes) + 42, centralOffset(bytes)),
        /local file header is out of bounds/,
      ],
    ];
    for (const [name, mutate, message] of cases) {
      const archive = join(directory, `${name}.zip`);
      const bytes = Buffer.from(base);
      mutate(bytes);
      await writeFile(archive, bytes, { mode: 0o600 });
      const maximumEntries = name === "too-many" ? 1 : 10;
      await expect(
        readZipEntries(archive, 64 * 1024 * 1024, maximumEntries),
      ).rejects.toThrow(message);
    }
  });

  it("rejects invalid central names and entry counts", async () => {
    const directory = await privateDirectory();
    const base = Buffer.from(zipSync({ "file.txt": strToU8("hello") }));
    const central = centralOffset(base);
    const nameStart = central + 46;
    for (const [name, byte] of [
      ["backslash", 0x5c],
      ["control", 0x00],
      ["utf8", 0xff],
    ] as const) {
      const bytes = Buffer.from(base);
      bytes[nameStart] = byte;
      const archive = join(directory, `${name}.zip`);
      await writeFile(archive, bytes, { mode: 0o600 });
      await expect(readZipEntries(archive, MAX_ARCHIVE, 10)).rejects.toThrow();
    }

    const extra = Buffer.from(base);
    writeU16(extra, endOffset(extra) + 10, 0);
    writeU16(extra, endOffset(extra) + 8, 0);
    const extraPath = join(directory, "extra.zip");
    await writeFile(extraPath, extra, { mode: 0o600 });
    await expect(readZipEntries(extraPath, MAX_ARCHIVE, 10)).rejects.toThrow(
      /extra data/,
    );

    const missing = Buffer.from(base);
    const centralSize = readU32(missing, endOffset(missing) + 12);
    writeU32(missing, endOffset(missing) + 12, centralSize - 1);
    const missingPath = join(directory, "truncated-central.zip");
    await writeFile(missingPath, missing, { mode: 0o600 });
    await expect(
      readZipEntries(missingPath, MAX_ARCHIVE, 10),
    ).rejects.toThrow();
  });

  it("rejects corrupted local headers, streams, and checksums", async () => {
    const directory = await privateDirectory();
    const base = Buffer.from(zipSync({ "file.txt": strToU8("hello world") }));
    const originalPath = join(directory, "original.zip");
    await writeFile(originalPath, base, { mode: 0o600 });
    const [entry] = await readZipEntries(originalPath, MAX_ARCHIVE, 10);
    expect(entry).toBeDefined();
    if (!entry) throw new Error("Expected ZIP entry");
    const cases: Array<[string, (bytes: Buffer) => void, RegExp]> = [
      [
        "local-signature",
        (bytes) => writeU32(bytes, entry.localHeaderOffset, 0),
        /local file header/,
      ],
      [
        "local-encrypted",
        (bytes) => writeU16(bytes, entry.localHeaderOffset + 6, 1),
        /Encrypted/,
      ],
      [
        "compression",
        (bytes) => writeU16(bytes, entry.localHeaderOffset + 8, 0),
        /compression metadata/,
      ],
      [
        "local-name",
        (bytes) => {
          bytes[entry.localHeaderOffset + 30] = 0x78;
        },
        /name metadata/,
      ],
      [
        "payload",
        (bytes) => {
          const offset = entryDataOffset(bytes, entry);
          const value = bytes[offset];
          if (value === undefined) throw new Error("Expected ZIP payload");
          bytes[offset] = value ^ 0xff;
        },
        /(checksum|invalid|unexpected|distance)/,
      ],
    ];
    for (const [name, mutate, message] of cases) {
      const bytes = Buffer.from(base);
      mutate(bytes);
      const archive = join(directory, `${name}.zip`);
      await writeFile(archive, bytes, { mode: 0o600 });
      const [corruptEntry] = await readZipEntries(archive, MAX_ARCHIVE, 10);
      if (!corruptEntry) throw new Error("Expected corrupt ZIP entry");
      await expect(
        readZipEntryBytes(archive, corruptEntry, 100),
      ).rejects.toThrow(message);
    }

    await expect(
      readZipEntryBytes(originalPath, { ...entry, compression: 99 }, 100),
    ).rejects.toThrow(/Unsupported/);
    await expect(
      readZipEntryBytes(
        originalPath,
        { ...entry, compression: 0, compressedSize: entry.originalSize + 1 },
        100,
      ),
    ).rejects.toThrow(/Stored ZIP entry sizes/);
    await expect(
      readZipEntryBytes(originalPath, { ...entry, originalSize: 1 }, 100),
    ).rejects.toThrow(/declared size/);
    await expect(
      readZipEntryBytes(originalPath, { ...entry, originalSize: 50 }, 100),
    ).rejects.toThrow(/size does not match/);
    await expect(
      readZipEntryBytes(
        originalPath,
        { ...entry, crc32: entry.crc32 ^ 1 },
        100,
      ),
    ).rejects.toThrow(/checksum/);
  });
});

async function privateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "cradlewise-zip-test-"));
  fixtureDirectories.push(directory);
  await chmod(directory, 0o700);
  return directory;
}

function endOffset(bytes: Uint8Array): number {
  for (let offset = bytes.byteLength - 22; offset >= 0; offset -= 1) {
    if (readU32(bytes, offset) === 0x06054b50) return offset;
  }
  throw new Error("end record missing");
}

function centralOffset(bytes: Uint8Array): number {
  return readU32(bytes, endOffset(bytes) + 16);
}

function entryDataOffset(
  bytes: Uint8Array,
  entry: { localHeaderOffset: number },
): number {
  const nameLength = readU16(bytes, entry.localHeaderOffset + 26);
  const extraLength = readU16(bytes, entry.localHeaderOffset + 28);
  return entry.localHeaderOffset + 30 + nameLength + extraLength;
}

function readU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

function writeU16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}
