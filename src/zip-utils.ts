import { constants } from "node:fs";
import { lstat, open, rm } from "node:fs/promises";
import type { Readable } from "node:stream";
import { createInflateRaw } from "node:zlib";

const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const MAX_END_RECORD_BYTES = 22 + 0xffff;
const MAX_CENTRAL_DIRECTORY_BYTES = 32 * 1024 * 1024;
const MAX_ZIP_NAME_BYTES = 8192;
const STREAM_CHUNK_BYTES = 1024 * 1024;
const crcTable = createCrcTable();

export interface ZipEntry {
  readonly name: string;
  readonly compression: number;
  readonly compressedSize: number;
  readonly originalSize: number;
  readonly crc32: number;
  readonly localHeaderOffset: number;
}

export async function readZipEntries(
  archivePath: string,
  maximumArchiveBytes: number,
  maximumEntries: number,
): Promise<ZipEntry[]> {
  const pathMetadata = await lstat(archivePath);
  if (
    !pathMetadata.isFile() ||
    pathMetadata.isSymbolicLink() ||
    pathMetadata.nlink !== 1 ||
    !Number.isSafeInteger(pathMetadata.size) ||
    pathMetadata.size < 22 ||
    pathMetadata.size > maximumArchiveBytes
  ) {
    throw new Error("ZIP archive is not a safe bounded regular file");
  }
  const handle = await open(
    archivePath,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  let operationFailed = false;
  let operationError: unknown;
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      metadata.dev !== pathMetadata.dev ||
      metadata.ino !== pathMetadata.ino ||
      !Number.isSafeInteger(metadata.size) ||
      metadata.size < 22 ||
      metadata.size > maximumArchiveBytes
    ) {
      throw new Error("ZIP archive is not a safe bounded regular file");
    }
    const tailLength = Math.min(metadata.size, MAX_END_RECORD_BYTES);
    const tail = await readExactly(
      handle,
      tailLength,
      metadata.size - tailLength,
    );
    const endOffset = findEndRecord(tail);
    const diskNumber = readUint16(tail, endOffset + 4);
    const centralDisk = readUint16(tail, endOffset + 6);
    const entriesOnDisk = readUint16(tail, endOffset + 8);
    const entryCount = readUint16(tail, endOffset + 10);
    const centralSize = readUint32(tail, endOffset + 12);
    const centralOffset = readUint32(tail, endOffset + 16);
    if (
      diskNumber !== 0 ||
      centralDisk !== 0 ||
      entriesOnDisk !== entryCount ||
      entryCount === 0xffff ||
      centralSize === 0xffffffff ||
      centralOffset === 0xffffffff
    ) {
      throw new Error("Multi-disk and ZIP64 archives are not supported");
    }
    if (entryCount > maximumEntries)
      throw new Error("ZIP contains too many entries");
    if (centralSize > MAX_CENTRAL_DIRECTORY_BYTES) {
      throw new Error("ZIP central directory exceeds the size limit");
    }
    const absoluteEndOffset = metadata.size - tailLength + endOffset;
    if (
      centralOffset > absoluteEndOffset ||
      centralSize > absoluteEndOffset - centralOffset
    ) {
      throw new Error("ZIP central directory is out of bounds");
    }
    const central = await readExactly(handle, centralSize, centralOffset);
    return parseCentralDirectory(central, entryCount, centralOffset);
  } catch (error) {
    operationFailed = true;
    operationError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    try {
      await handle.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    throwZipCleanupFailures(
      operationFailed,
      operationError,
      cleanupErrors,
      "ZIP archive inspection and handle cleanup failed",
    );
  }
}

export async function readZipEntryBytes(
  archivePath: string,
  entry: ZipEntry,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (entry.originalSize > maximumBytes) {
    throw new Error("ZIP entry exceeds the size limit");
  }
  const output = new Uint8Array(entry.originalSize);
  let offset = 0;
  for await (const chunk of streamZipEntry(archivePath, entry)) {
    if (chunk.byteLength > output.byteLength - offset) {
      throw new Error("ZIP entry exceeds its declared size");
    }
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset !== output.byteLength)
    throw new Error("ZIP entry size does not match metadata");
  return output;
}

export async function writeZipEntryToFile(
  archivePath: string,
  entry: ZipEntry,
  destinationPath: string,
  maximumBytes: number,
): Promise<void> {
  if (entry.originalSize > maximumBytes) {
    throw new Error("ZIP entry exceeds the size limit");
  }
  const destination = await open(destinationPath, "wx", 0o600);
  try {
    for await (const chunk of streamZipEntry(archivePath, entry)) {
      await writeAll(destination, chunk);
    }
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try {
      await destination.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      await rm(destinationPath, { force: true });
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    throwZipCleanupFailures(
      true,
      error,
      cleanupErrors,
      "ZIP entry extraction and output cleanup failed",
    );
    throw error;
  }
  await destination.close();
}

export async function* streamZipEntry(
  archivePath: string,
  entry: ZipEntry,
): AsyncGenerator<Uint8Array, void, void> {
  if (entry.compression !== 0 && entry.compression !== 8) {
    throw new Error(`Unsupported ZIP compression method: ${entry.compression}`);
  }
  if (entry.compression === 0 && entry.compressedSize !== entry.originalSize) {
    throw new Error("Stored ZIP entry sizes do not match");
  }
  const pathMetadata = await lstat(archivePath);
  if (
    !pathMetadata.isFile() ||
    pathMetadata.isSymbolicLink() ||
    pathMetadata.nlink !== 1
  ) {
    throw new Error("ZIP archive changed before entry extraction");
  }
  const handle = await open(
    archivePath,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  let source: Readable | undefined;
  let decoded: Readable | undefined;
  let operationFailed = false;
  let operationError: unknown;
  try {
    const metadata = await handle.stat();
    if (
      !pathMetadata.isFile() ||
      pathMetadata.isSymbolicLink() ||
      pathMetadata.nlink !== 1 ||
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      metadata.dev !== pathMetadata.dev ||
      metadata.ino !== pathMetadata.ino
    ) {
      throw new Error("ZIP archive changed before entry extraction");
    }
    const localHeader = await readExactly(handle, 30, entry.localHeaderOffset);
    if (readUint32(localHeader, 0) !== LOCAL_FILE_HEADER_SIGNATURE) {
      throw new Error("ZIP local file header is invalid");
    }
    const flags = readUint16(localHeader, 6);
    const compression = readUint16(localHeader, 8);
    const nameLength = readUint16(localHeader, 26);
    const extraLength = readUint16(localHeader, 28);
    if ((flags & 1) !== 0)
      throw new Error("Encrypted ZIP entries are not supported");
    if (compression !== entry.compression) {
      throw new Error("ZIP compression metadata does not match");
    }
    const localName = decodeZipName(
      await readExactly(handle, nameLength, entry.localHeaderOffset + 30),
    );
    if (localName !== entry.name)
      throw new Error("ZIP entry name metadata does not match");
    const dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength;
    if (
      dataOffset > metadata.size ||
      entry.compressedSize > metadata.size - dataOffset
    ) {
      throw new Error("ZIP entry data is out of bounds");
    }
    if (entry.compressedSize === 0) {
      if (entry.originalSize !== 0)
        throw new Error("ZIP entry data is missing");
      if (entry.crc32 !== 0)
        throw new Error("ZIP entry checksum does not match");
      return;
    }

    let outputBytes = 0;
    let checksum = 0xffffffff;
    if (entry.compression === 0) {
      const buffer = new Uint8Array(
        Math.min(STREAM_CHUNK_BYTES, entry.originalSize),
      );
      let position = dataOffset;
      while (outputBytes < entry.originalSize) {
        const requested = Math.min(
          buffer.byteLength,
          entry.originalSize - outputBytes,
        );
        const { bytesRead } = await handle.read(buffer, 0, requested, position);
        if (bytesRead === 0) throw new Error("ZIP entry data is truncated");
        const chunk =
          bytesRead === buffer.byteLength
            ? buffer
            : buffer.subarray(0, bytesRead);
        outputBytes += bytesRead;
        position += bytesRead;
        checksum = updateCrc32(checksum, chunk);
        yield chunk;
      }
    } else {
      source = handle.createReadStream({
        autoClose: false,
        start: dataOffset,
        end: dataOffset + entry.compressedSize - 1,
        highWaterMark: STREAM_CHUNK_BYTES,
      });
      decoded = source.pipe(createInflateRaw());
      for await (const rawChunk of decoded) {
        if (!(rawChunk instanceof Uint8Array)) {
          throw new Error("ZIP decoder returned an invalid chunk");
        }
        const chunk = rawChunk;
        outputBytes += chunk.byteLength;
        if (outputBytes > entry.originalSize) {
          throw new Error("ZIP entry exceeds its declared size");
        }
        checksum = updateCrc32(checksum, chunk);
        yield chunk;
      }
    }
    if (outputBytes !== entry.originalSize) {
      throw new Error("ZIP entry size does not match metadata");
    }
    if ((checksum ^ 0xffffffff) >>> 0 !== entry.crc32) {
      throw new Error("ZIP entry checksum does not match");
    }
  } catch (error) {
    operationFailed = true;
    operationError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    try {
      source?.destroy();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (decoded && decoded !== source) decoded.destroy();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await handle.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    throwZipCleanupFailures(
      operationFailed,
      operationError,
      cleanupErrors,
      "ZIP entry streaming and cleanup failed",
    );
  }
}

export function throwZipCleanupFailures(
  operationFailed: boolean,
  operationError: unknown,
  cleanupErrors: unknown[],
  message: string,
): void {
  if (cleanupErrors.length === 0) return;
  if (operationFailed) {
    throw new AggregateError([operationError, ...cleanupErrors], message, {
      cause: operationError,
    });
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  throw new AggregateError(cleanupErrors, message, {
    cause: cleanupErrors.at(-1),
  });
}

function findEndRecord(tail: Uint8Array): number {
  for (let offset = tail.byteLength - 22; offset >= 0; offset -= 1) {
    if (readUint32(tail, offset) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE)
      continue;
    const commentLength = readUint16(tail, offset + 20);
    if (offset + 22 + commentLength === tail.byteLength) return offset;
  }
  throw new Error("ZIP end-of-central-directory record is missing");
}

function parseCentralDirectory(
  central: Uint8Array,
  expectedEntries: number,
  centralOffset: number,
): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let offset = 0;
  while (offset < central.byteLength) {
    if (entries.length >= expectedEntries) {
      throw new Error("ZIP central directory contains extra data");
    }
    if (central.byteLength - offset < 46) {
      throw new Error("ZIP central directory entry is truncated");
    }
    if (readUint32(central, offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error("ZIP central directory signature is invalid");
    }
    const flags = readUint16(central, offset + 8);
    const compression = readUint16(central, offset + 10);
    const crc32 = readUint32(central, offset + 16);
    const compressedSize = readUint32(central, offset + 20);
    const originalSize = readUint32(central, offset + 24);
    const nameLength = readUint16(central, offset + 28);
    const extraLength = readUint16(central, offset + 30);
    const commentLength = readUint16(central, offset + 32);
    const diskStart = readUint16(central, offset + 34);
    const localHeaderOffset = readUint32(central, offset + 42);
    if ((flags & 1) !== 0)
      throw new Error("Encrypted ZIP entries are not supported");
    if (
      compressedSize === 0xffffffff ||
      originalSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff ||
      diskStart !== 0
    ) {
      throw new Error("Multi-disk and ZIP64 entries are not supported");
    }
    if (nameLength === 0 || nameLength > MAX_ZIP_NAME_BYTES) {
      throw new Error("ZIP entry name is invalid");
    }
    const recordLength = 46 + nameLength + extraLength + commentLength;
    if (recordLength > central.byteLength - offset) {
      throw new Error("ZIP central directory entry is out of bounds");
    }
    if (localHeaderOffset >= centralOffset) {
      throw new Error("ZIP local file header is out of bounds");
    }
    const name = decodeZipName(
      central.subarray(offset + 46, offset + 46 + nameLength),
    );
    entries.push({
      name,
      compression,
      compressedSize,
      originalSize,
      crc32,
      localHeaderOffset,
    });
    offset += recordLength;
  }
  if (entries.length !== expectedEntries) {
    throw new Error("ZIP entry count does not match metadata");
  }
  return entries;
}

function decodeZipName(bytes: Uint8Array): string {
  const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!name || name.includes("\\") || hasControlCharacter(name)) {
    throw new Error("ZIP entry name is invalid");
  }
  return name;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    )
      return true;
  }
  return false;
}

async function readExactly(
  handle: Awaited<ReturnType<typeof open>>,
  length: number,
  position: number,
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(length) ||
    length < 0 ||
    !Number.isSafeInteger(position) ||
    position < 0
  ) {
    throw new Error("ZIP read range is invalid");
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(
      bytes,
      offset,
      length - offset,
      position + offset,
    );
    if (bytesRead === 0) throw new Error("ZIP archive ended unexpectedly");
    offset += bytesRead;
  }
  return bytes;
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(
      bytes,
      offset,
      bytes.byteLength - offset,
    );
    if (bytesWritten <= 0)
      throw new Error("Unable to write extracted ZIP entry");
    offset += bytesWritten;
  }
}

function readUint16(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.byteLength)
    throw new Error("ZIP metadata is truncated");
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint16(offset, true);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.byteLength)
    throw new Error("ZIP metadata is truncated");
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(offset, true);
}

function createCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function updateCrc32(checksum: number, bytes: Uint8Array): number {
  let value = checksum;
  for (const byte of bytes) {
    const tableValue = crcTable[(value ^ byte) & 0xff];
    if (tableValue === undefined) throw new Error("CRC table is incomplete");
    value = tableValue ^ (value >>> 8);
  }
  return value >>> 0;
}
