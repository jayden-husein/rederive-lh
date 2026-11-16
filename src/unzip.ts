// Minimal ZIP reader for release packages: the counterpart of scripts/zip.ts. Reads the
// central directory, supports stored and deflated entries, and checks every CRC. No zip64,
// encryption or multi-disk archives: a release zip never uses them.
import { crc32, inflateRawSync } from "node:zlib";

export interface UnzippedEntry {
  /** Path inside the archive, as stored (forward slashes). */
  name: string;
  data: Buffer;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export interface ReadZipOptions {
  /** Refuse archives whose entries add up to more than this many bytes uncompressed. */
  maxTotalBytes: number;
}

export function readZip(zip: Buffer, { maxTotalBytes }: ReadZipOptions): UnzippedEntry[] {
  const end = findEndOfCentralDirectory(zip);
  const count = zip.readUInt16LE(end + 10);
  const size = zip.readUInt32LE(end + 12);
  let at = zip.readUInt32LE(end + 16);
  if (at + size > end) throw new Error("The zip's central directory is damaged.");

  const entries: UnzippedEntry[] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || zip.readUInt32LE(at) !== CENTRAL) throw new Error("The zip's central directory is damaged.");
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const compressedSize = zip.readUInt32LE(at + 20);
    const uncompressedSize = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const localOffset = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    at += 46 + nameLength + extraLength + commentLength;

    if (flags & 0x1) throw new Error(`Zip entry ${name} is encrypted.`);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error("Zip64 archives are not supported.");
    }
    total += uncompressedSize;
    if (total > maxTotalBytes) throw new Error("The zip unpacks to more than expected.");

    if (localOffset + 30 > zip.length || zip.readUInt32LE(localOffset) !== LOCAL) {
      throw new Error(`Zip entry ${name} is damaged.`);
    }
    const dataStart = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
    if (dataStart + compressedSize > zip.length) throw new Error(`Zip entry ${name} is cut short.`);
    const raw = zip.subarray(dataStart, dataStart + compressedSize);

    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: Math.max(uncompressedSize, 1) });
    else throw new Error(`Zip entry ${name} uses an unsupported compression method (${method}).`);
    if (data.length !== uncompressedSize || crc32(data) !== crc) throw new Error(`Zip entry ${name} failed its checksum.`);
    entries.push({ name, data });
  }
  return entries;
}

function findEndOfCentralDirectory(zip: Buffer): number {
  // The record is 22 bytes plus a comment of at most 65535 bytes, at the very end.
  const lowest = Math.max(0, zip.length - 22 - 0xffff);
  for (let at = zip.length - 22; at >= lowest; at--) {
    if (zip.readUInt32LE(at) === EOCD) return at;
  }
  throw new Error("Not a zip file.");
}
