import { execFile } from "node:child_process";
import { open } from "node:fs/promises";

import type { JsonObject } from "../domain/index.js";
import type { HashTask } from "./types.js";

export type AnalyzerOutcome =
  | { readonly status: "completed"; readonly facts: JsonObject; readonly warnings: readonly string[] }
  | { readonly status: "unavailable"; readonly facts: JsonObject; readonly warnings: readonly string[] };

export interface LocalMetadataAnalyzer {
  readonly id: string;
  readonly version: string;
  supports(task: HashTask): boolean;
  analyze(task: HashTask, absolutePath: string): Promise<AnalyzerOutcome>;
}

const IMAGE_EXTENSIONS = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff", "heic", "heif", "avif",
  "dng", "cr2", "nef", "raw",
]);
const VIDEO_EXTENSIONS = new Set([
  "mp4", "mov", "mkv", "avi", "webm", "m4v", "mpg", "mpeg", "wmv", "flv",
]);
const AUDIO_EXTENSIONS = new Set([
  "mp3", "wav", "flac", "m4a", "aac", "ogg", "opus", "wma", "aiff",
]);
const DOCUMENT_EXTENSIONS = new Set([
  "pdf", "doc", "docx", "odt", "rtf", "txt", "md", "tex", "pages", "ppt", "pptx",
  "odp", "xls", "xlsx", "ods", "epub",
]);
const ARCHIVE_EXTENSIONS = new Set([
  "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "tgz", "iso", "cbz",
]);

export function defaultMetadataAnalyzers(): readonly LocalMetadataAnalyzer[] {
  return [
    new BasicTypeAnalyzer(),
    new ImageMetadataAnalyzer(),
    new AudioTagAnalyzer(),
    new DocumentMetadataAnalyzer(),
    new ArchiveMetadataAnalyzer(),
    new FfprobeMediaAnalyzer(),
  ];
}

export class BasicTypeAnalyzer implements LocalMetadataAnalyzer {
  public readonly id = "basic-type";
  public readonly version = "2.0.0";

  public supports(): boolean {
    return true;
  }

  public async analyze(task: HashTask, absolutePath: string): Promise<AnalyzerOutcome> {
    const head = await readPrefix(absolutePath, 560);
    const detected = detectType(head, extension(task));
    return {
      status: "completed",
      facts: {
        mimeType: detected.mimeType,
        format: detected.format,
        source: detected.source,
      },
      warnings: detected.source === "extension"
        ? ["Type was inferred from the filename extension because no known signature was present."]
        : [],
    };
  }
}

export class ImageMetadataAnalyzer implements LocalMetadataAnalyzer {
  public readonly id = "image-metadata";
  public readonly version = "2.1.0";

  public supports(task: HashTask): boolean {
    return IMAGE_EXTENSIONS.has(extension(task));
  }

  public async analyze(_task: HashTask, absolutePath: string): Promise<AnalyzerOutcome> {
    const buffer = await readPrefix(absolutePath, 4 * 1024 * 1024);
    const metadata = parseImage(buffer);
    if (metadata === undefined) {
      return {
        status: "unavailable",
        facts: {},
        warnings: ["This image container is recognized, but its local metadata could not be parsed."],
      };
    }
    return { status: "completed", facts: metadata, warnings: [] };
  }
}

export class AudioTagAnalyzer implements LocalMetadataAnalyzer {
  public readonly id = "audio-tags";
  public readonly version = "2.0.0";

  public supports(task: HashTask): boolean {
    return AUDIO_EXTENSIONS.has(extension(task));
  }

  public async analyze(task: HashTask, absolutePath: string): Promise<AnalyzerOutcome> {
    const head = await readPrefix(absolutePath, 2 * 1024 * 1024);
    if (head.subarray(0, 3).toString("ascii") === "ID3") {
      return { status: "completed", facts: parseId3(head), warnings: [] };
    }
    if (head.subarray(0, 4).toString("ascii") === "RIFF" && head.subarray(8, 12).toString("ascii") === "WAVE") {
      return { status: "completed", facts: parseWave(head, task.byteLength), warnings: [] };
    }
    return {
      status: "unavailable",
      facts: {},
      warnings: ["Embedded audio tags require ffprobe or a supported ID3/WAVE container."],
    };
  }
}

export class DocumentMetadataAnalyzer implements LocalMetadataAnalyzer {
  public readonly id = "document-metadata";
  public readonly version = "2.0.0";

  public supports(task: HashTask): boolean {
    return DOCUMENT_EXTENSIONS.has(extension(task));
  }

  public async analyze(task: HashTask, absolutePath: string): Promise<AnalyzerOutcome> {
    if (extension(task) !== "pdf") {
      return {
        status: "completed",
        facts: { format: extension(task).toUpperCase(), structuralInspection: "container-only" },
        warnings: ["Only safe container-level metadata is collected for this document format."],
      };
    }
    const maximumWindow = 2 * 1024 * 1024;
    const head = await readPrefix(absolutePath, maximumWindow);
    // Avoid counting the same structural objects twice when a document is
    // smaller than the combined head/tail sample windows.
    const tailBytes = Math.min(maximumWindow, Math.max(0, task.byteLength - head.byteLength));
    const tail = tailBytes === 0 ? Buffer.alloc(0) : await readSuffix(absolutePath, tailBytes);
    const text = Buffer.concat([head, tail]).toString("latin1");
    const pages = text.match(/\/Type\s*\/Page\b/gu)?.length ?? 0;
    const title = pdfInfoValue(text, "Title");
    const author = pdfInfoValue(text, "Author");
    const created = pdfInfoValue(text, "CreationDate");
    const modified = pdfInfoValue(text, "ModDate");
    return {
      status: "completed",
      facts: {
        format: "PDF",
        mimeType: "application/pdf",
        ...(pages === 0 ? {} : { pageCount: pages, pageCountMethod: "structural-estimate" }),
        ...(title === undefined ? {} : { title }),
        ...(author === undefined ? {} : { author }),
        ...(created === undefined ? {} : { documentCreatedAt: created }),
        ...(modified === undefined ? {} : { documentModifiedAt: modified }),
      },
      warnings: pages === 0
        ? ["Page count was unavailable without rendering or decrypting the PDF."]
        : ["PDF page count is a structural estimate and may omit compressed object streams."],
    };
  }
}

export class ArchiveMetadataAnalyzer implements LocalMetadataAnalyzer {
  public readonly id = "archive-metadata";
  public readonly version = "2.0.0";

  public supports(task: HashTask): boolean {
    return ARCHIVE_EXTENSIONS.has(extension(task));
  }

  public async analyze(task: HashTask, absolutePath: string): Promise<AnalyzerOutcome> {
    const [head, tail] = await Promise.all([
      readPrefix(absolutePath, 560),
      readSuffix(absolutePath, 66_000),
    ]);
    const zip = zipMetadata(tail);
    if (zip !== undefined) {
      return {
        status: "completed",
        facts: {
          archiveType: "zip",
          entryCount: zip.entryCount,
          centralDirectoryBytes: zip.centralDirectoryBytes,
          encryptedOrSpanned: zip.diskNumber !== 0,
          inspectedWithoutExtraction: true,
        },
        warnings: [],
      };
    }
    const type = archiveType(head, extension(task));
    return {
      status: "completed",
      facts: { archiveType: type, inspectedWithoutExtraction: true },
      warnings: ["Entry enumeration is not available for this archive type without an optional local tool."],
    };
  }
}

export interface FfprobeExecutor {
  execute(arguments_: readonly string[]): Promise<string>;
}

export class FfprobeMediaAnalyzer implements LocalMetadataAnalyzer {
  public readonly id = "ffprobe-media";
  public readonly version = "2.0.0";
  readonly #executor: FfprobeExecutor;
  #availability: Promise<boolean> | undefined;

  public constructor(executor: FfprobeExecutor = new SystemFfprobeExecutor()) {
    this.#executor = executor;
  }

  public supports(task: HashTask): boolean {
    const value = extension(task);
    return AUDIO_EXTENSIONS.has(value) || VIDEO_EXTENSIONS.has(value);
  }

  public async analyze(_task: HashTask, absolutePath: string): Promise<AnalyzerOutcome> {
    this.#availability ??= this.#executor.execute(["-version"])
      .then(() => true)
      .catch(() => false);
    if (!(await this.#availability)) {
      return {
        status: "unavailable",
        facts: { prerequisite: "ffprobe" },
        warnings: ["ffprobe is not installed; basic local tags remain available where supported."],
      };
    }
    const stdout = await this.#executor.execute([
      "-v", "error",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      absolutePath,
    ]);
    return { status: "completed", facts: normalizeFfprobe(parseObject(stdout)), warnings: [] };
  }
}

class SystemFfprobeExecutor implements FfprobeExecutor {
  public execute(arguments_: readonly string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        "ffprobe",
        [...arguments_],
        { encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
        (error, stdout) => error === null ? resolve(stdout) : reject(error),
      );
    });
  }
}

async function readPrefix(filePath: string, maximumBytes: number): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const stats = await handle.stat();
    const length = Math.min(maximumBytes, stats.size);
    const buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}

async function readSuffix(filePath: string, maximumBytes: number): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const stats = await handle.stat();
    const length = Math.min(maximumBytes, stats.size);
    const buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, length, Math.max(0, stats.size - length));
    return buffer.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}

function extension(task: HashTask): string {
  return task.extension?.toLocaleLowerCase("en-US") ?? "";
}

function detectType(
  head: Buffer,
  extensionValue: string,
): { readonly mimeType: string; readonly format: string; readonly source: "signature" | "extension" } {
  const signature = signatureType(head);
  if (signature !== undefined) return { ...signature, source: "signature" };
  return {
    ...(extensionType(extensionValue) ?? { mimeType: "application/octet-stream", format: "Unknown" }),
    source: "extension",
  };
}

function signatureType(head: Buffer): { readonly mimeType: string; readonly format: string } | undefined {
  if (head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { mimeType: "image/png", format: "PNG" };
  }
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return { mimeType: "image/jpeg", format: "JPEG" };
  }
  if (head.subarray(0, 6).toString("ascii").startsWith("GIF8")) {
    return { mimeType: "image/gif", format: "GIF" };
  }
  if (head.subarray(0, 4).toString("ascii") === "RIFF" && head.subarray(8, 12).toString("ascii") === "WEBP") {
    return { mimeType: "image/webp", format: "WebP" };
  }
  if (head.subarray(0, 4).toString("ascii") === "RIFF" && head.subarray(8, 12).toString("ascii") === "WAVE") {
    return { mimeType: "audio/wav", format: "WAVE" };
  }
  if (head.subarray(0, 4).toString("ascii") === "%PDF") {
    return { mimeType: "application/pdf", format: "PDF" };
  }
  if (head[0] === 0x50 && head[1] === 0x4b && [0x03, 0x05, 0x07].includes(head[2] ?? -1)) {
    return { mimeType: "application/zip", format: "ZIP" };
  }
  if (head.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) {
    return { mimeType: "application/x-7z-compressed", format: "7-Zip" };
  }
  if (head[0] === 0x1f && head[1] === 0x8b) {
    return { mimeType: "application/gzip", format: "GZip" };
  }
  if (head.subarray(0, 3).toString("ascii") === "ID3") {
    return { mimeType: "audio/mpeg", format: "MP3" };
  }
  if (head.subarray(257, 262).toString("ascii") === "ustar") {
    return { mimeType: "application/x-tar", format: "TAR" };
  }
  return undefined;
}

function extensionType(value: string): { readonly mimeType: string; readonly format: string } | undefined {
  const map: Readonly<Record<string, { mimeType: string; format: string }>> = {
    jpg: { mimeType: "image/jpeg", format: "JPEG" },
    jpeg: { mimeType: "image/jpeg", format: "JPEG" },
    png: { mimeType: "image/png", format: "PNG" },
    gif: { mimeType: "image/gif", format: "GIF" },
    webp: { mimeType: "image/webp", format: "WebP" },
    heic: { mimeType: "image/heic", format: "HEIC" },
    heif: { mimeType: "image/heif", format: "HEIF" },
    mp4: { mimeType: "video/mp4", format: "MP4" },
    mov: { mimeType: "video/quicktime", format: "QuickTime" },
    mkv: { mimeType: "video/x-matroska", format: "Matroska" },
    mp3: { mimeType: "audio/mpeg", format: "MP3" },
    flac: { mimeType: "audio/flac", format: "FLAC" },
    wav: { mimeType: "audio/wav", format: "WAVE" },
    pdf: { mimeType: "application/pdf", format: "PDF" },
    zip: { mimeType: "application/zip", format: "ZIP" },
    json: { mimeType: "application/json", format: "JSON" },
    txt: { mimeType: "text/plain", format: "Plain text" },
    md: { mimeType: "text/markdown", format: "Markdown" },
    html: { mimeType: "text/html", format: "HTML" },
    csv: { mimeType: "text/csv", format: "CSV" },
  };
  return map[value];
}

function parseImage(buffer: Buffer): JsonObject | undefined {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && buffer.length >= 24) {
    return { format: "PNG", width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.subarray(0, 6).toString("ascii").startsWith("GIF8") && buffer.length >= 10) {
    return { format: "GIF", width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (buffer.subarray(0, 2).toString("ascii") === "BM" && buffer.length >= 26) {
    return {
      format: "BMP",
      width: Math.abs(buffer.readInt32LE(18)),
      height: Math.abs(buffer.readInt32LE(22)),
    };
  }
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    if (buffer.subarray(12, 16).toString("ascii") === "VP8X" && buffer.length >= 30) {
      return {
        format: "WebP",
        width: 1 + readUInt24LE(buffer, 24),
        height: 1 + readUInt24LE(buffer, 27),
      };
    }
    return { format: "WebP" };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return parseJpeg(buffer);
  if (
    buffer.length >= 8 &&
    ((buffer.subarray(0, 2).toString("ascii") === "II" && buffer.readUInt16LE(2) === 42) ||
      (buffer.subarray(0, 2).toString("ascii") === "MM" && buffer.readUInt16BE(2) === 42))
  ) {
    return { format: "TIFF", ...parseTiffExif(buffer, 0) };
  }
  return undefined;
}

function parseJpeg(buffer: Buffer): JsonObject {
  let offset = 2;
  let width: number | undefined;
  let height: number | undefined;
  let exif: JsonObject = {};
  while (offset + 4 <= buffer.length) {
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset] ?? 0;
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    const dataStart = offset + 2;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (dataStart + 5 <= buffer.length) {
        height = buffer.readUInt16BE(dataStart + 1);
        width = buffer.readUInt16BE(dataStart + 3);
      }
    }
    if (
      marker === 0xe1 &&
      buffer.subarray(dataStart, dataStart + 6).equals(Buffer.from("Exif\0\0", "binary"))
    ) {
      exif = parseTiffExif(buffer.subarray(dataStart + 6, offset + length), 0);
    }
    offset += length;
  }
  return {
    format: "JPEG",
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    ...exif,
  };
}

function parseTiffExif(buffer: Buffer, base: number): JsonObject {
  try {
    const little = buffer.subarray(base, base + 2).toString("ascii") === "II";
    const u16 = (offset: number): number => little ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
    const u32 = (offset: number): number => little ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
    const first = base + u32(base + 4);
    const root = readIfd(buffer, base, first, little);
    const exifOffset = numberValue(root.get(0x8769));
    const gpsOffset = numberValue(root.get(0x8825));
    const exif = exifOffset === undefined ? new Map<number, IfdValue>() : readIfd(buffer, base, base + exifOffset, little);
    const gps = gpsOffset === undefined ? new Map<number, IfdValue>() : readIfd(buffer, base, base + gpsOffset, little);
    const captureOriginal = stringValue(exif.get(0x9003)) ?? stringValue(exif.get(0x9004)) ?? stringValue(root.get(0x0132));
    const location = gpsCoordinates(gps);
    const width = numberValue(exif.get(0xa002));
    const height = numberValue(exif.get(0xa003));
    return {
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
      ...(captureOriginal === undefined
        ? {}
        : { captureDateOriginal: captureOriginal, captureAt: normalizeExifDate(captureOriginal) }),
      ...(numberValue(root.get(0x0112)) === undefined ? {} : { orientation: numberValue(root.get(0x0112))! }),
      ...(stringValue(root.get(0x010f)) === undefined ? {} : { cameraMake: stringValue(root.get(0x010f))! }),
      ...(stringValue(root.get(0x0110)) === undefined ? {} : { cameraModel: stringValue(root.get(0x0110))! }),
      ...(location === undefined ? {} : { gps: location, privacy: "local-only" }),
    };
  } catch {
    return {};
  }
}

interface IfdValue {
  readonly type: number;
  readonly count: number;
  readonly value: unknown;
}

function readIfd(
  buffer: Buffer,
  base: number,
  offset: number,
  little: boolean,
): Map<number, IfdValue> {
  const result = new Map<number, IfdValue>();
  const u16 = (at: number): number => little ? buffer.readUInt16LE(at) : buffer.readUInt16BE(at);
  const u32 = (at: number): number => little ? buffer.readUInt32LE(at) : buffer.readUInt32BE(at);
  if (offset < 0 || offset + 2 > buffer.length) return result;
  const count = Math.min(u16(offset), 512);
  for (let index = 0; index < count; index += 1) {
    const entry = offset + 2 + index * 12;
    if (entry + 12 > buffer.length) break;
    const tag = u16(entry);
    const type = u16(entry + 2);
    const values = u32(entry + 4);
    const size = typeSize(type) * values;
    const dataOffset = size <= 4 ? entry + 8 : base + u32(entry + 8);
    if (size < 0 || dataOffset < 0 || dataOffset + size > buffer.length) continue;
    result.set(tag, { type, count: values, value: decodeTiffValue(buffer, dataOffset, type, values, little) });
  }
  return result;
}

function typeSize(type: number): number {
  if ([1, 2, 6, 7].includes(type)) return 1;
  if ([3, 8].includes(type)) return 2;
  if ([4, 9, 11].includes(type)) return 4;
  if ([5, 10, 12].includes(type)) return 8;
  return 0;
}

function decodeTiffValue(
  buffer: Buffer,
  offset: number,
  type: number,
  count: number,
  little: boolean,
): unknown {
  const u16 = (at: number): number => little ? buffer.readUInt16LE(at) : buffer.readUInt16BE(at);
  const u32 = (at: number): number => little ? buffer.readUInt32LE(at) : buffer.readUInt32BE(at);
  if (type === 2) return buffer.subarray(offset, offset + count).toString("ascii").replace(/\0+$/u, "").trim();
  if (type === 3) {
    const values = Array.from({ length: count }, (_, index) => u16(offset + index * 2));
    return count === 1 ? values[0] : values;
  }
  if (type === 4) {
    const values = Array.from({ length: count }, (_, index) => u32(offset + index * 4));
    return count === 1 ? values[0] : values;
  }
  if (type === 5) {
    const values = Array.from({ length: count }, (_, index) => {
      const numerator = u32(offset + index * 8);
      const denominator = u32(offset + index * 8 + 4);
      return denominator === 0 ? 0 : numerator / denominator;
    });
    return count === 1 ? values[0] : values;
  }
  if ([1, 6, 7].includes(type)) {
    const values = [...buffer.subarray(offset, offset + count)];
    return count === 1 ? values[0] : values;
  }
  return undefined;
}

function numberValue(value: IfdValue | undefined): number | undefined {
  return typeof value?.value === "number" ? value.value : undefined;
}

function stringValue(value: IfdValue | undefined): string | undefined {
  return typeof value?.value === "string" && value.value.length > 0 ? value.value : undefined;
}

function gpsCoordinates(gps: Map<number, IfdValue>): JsonObject | undefined {
  const lat = gps.get(2)?.value;
  const lon = gps.get(4)?.value;
  if (!Array.isArray(lat) || !Array.isArray(lon) || lat.length < 3 || lon.length < 3) return undefined;
  const latitude = degrees(lat) * (stringValue(gps.get(1)) === "S" ? -1 : 1);
  const longitude = degrees(lon) * (stringValue(gps.get(3)) === "W" ? -1 : 1);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined;
  const altitude = numberValue(gps.get(6));
  return {
    latitude,
    longitude,
    ...(altitude === undefined ? {} : { altitude: numberValue(gps.get(5)) === 1 ? -altitude : altitude }),
  };
}

function degrees(values: readonly unknown[]): number {
  return Number(values[0]) + Number(values[1]) / 60 + Number(values[2]) / 3600;
}

function normalizeExifDate(value: string): string {
  return value.replace(/^(\d{4}):(\d{2}):(\d{2})\s/u, "$1-$2-$3T");
}

function readUInt24LE(buffer: Buffer, offset: number): number {
  return (buffer[offset] ?? 0) | ((buffer[offset + 1] ?? 0) << 8) | ((buffer[offset + 2] ?? 0) << 16);
}

function parseId3(buffer: Buffer): JsonObject {
  const version = buffer[3] ?? 3;
  const declared = synchsafe(buffer, 6);
  const end = Math.min(buffer.length, 10 + declared);
  const tags: Record<string, string> = {};
  let offset = 10;
  while (offset + 10 <= end) {
    const id = buffer.subarray(offset, offset + 4).toString("ascii");
    if (!/^[A-Z0-9]{4}$/u.test(id)) break;
    const size = version >= 4 ? synchsafe(buffer, offset + 4) : buffer.readUInt32BE(offset + 4);
    if (size <= 0 || offset + 10 + size > end) break;
    if (["TIT2", "TPE1", "TALB", "TRCK", "TDRC", "TYER"].includes(id)) {
      tags[id] = decodeId3Text(buffer.subarray(offset + 10, offset + 10 + size));
    }
    offset += 10 + size;
  }
  return {
    format: "MP3",
    ...(tags["TIT2"] === undefined ? {} : { title: tags["TIT2"] }),
    ...(tags["TPE1"] === undefined ? {} : { artist: tags["TPE1"] }),
    ...(tags["TALB"] === undefined ? {} : { album: tags["TALB"] }),
    ...(tags["TRCK"] === undefined ? {} : { track: tags["TRCK"] }),
    ...(tags["TDRC"] === undefined && tags["TYER"] === undefined
      ? {}
      : { recordingDate: tags["TDRC"] ?? tags["TYER"]! }),
  };
}

function synchsafe(buffer: Buffer, offset: number): number {
  return ((buffer[offset] ?? 0) << 21) |
    ((buffer[offset + 1] ?? 0) << 14) |
    ((buffer[offset + 2] ?? 0) << 7) |
    (buffer[offset + 3] ?? 0);
}

function decodeId3Text(value: Buffer): string {
  const encoding = value[0] ?? 0;
  const body = value.subarray(1);
  if (encoding === 0) return body.toString("latin1").replace(/\0+$/u, "").trim();
  if (encoding === 3) return body.toString("utf8").replace(/\0+$/u, "").trim();
  if (encoding === 1) {
    const little = body[0] === 0xff && body[1] === 0xfe;
    const content = body.subarray(body[0] === 0xff || body[0] === 0xfe ? 2 : 0);
    return decodeUtf16(content, little).replace(/\0+$/u, "").trim();
  }
  return decodeUtf16(body, false).replace(/\0+$/u, "").trim();
}

function decodeUtf16(buffer: Buffer, little: boolean): string {
  if (little) return buffer.toString("utf16le");
  const copy = Buffer.from(buffer);
  for (let offset = 0; offset + 1 < copy.length; offset += 2) {
    const first = copy[offset]!;
    copy[offset] = copy[offset + 1]!;
    copy[offset + 1] = first;
  }
  return copy.toString("utf16le");
}

function parseWave(buffer: Buffer, totalBytes: number): JsonObject {
  let offset = 12;
  let channels: number | undefined;
  let sampleRate: number | undefined;
  let bitsPerSample: number | undefined;
  let byteRate: number | undefined;
  let dataBytes: number | undefined;
  while (offset + 8 <= buffer.length) {
    const id = buffer.subarray(offset, offset + 4).toString("ascii");
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "fmt " && offset + 24 <= buffer.length) {
      channels = buffer.readUInt16LE(offset + 10);
      sampleRate = buffer.readUInt32LE(offset + 12);
      byteRate = buffer.readUInt32LE(offset + 16);
      bitsPerSample = buffer.readUInt16LE(offset + 22);
    }
    if (id === "data") {
      dataBytes = size === 0xffffffff ? Math.max(0, totalBytes - offset - 8) : size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  return {
    format: "WAVE",
    ...(channels === undefined ? {} : { channels }),
    ...(sampleRate === undefined ? {} : { sampleRate }),
    ...(bitsPerSample === undefined ? {} : { bitsPerSample }),
    ...(dataBytes === undefined || byteRate === undefined || byteRate === 0
      ? {}
      : { durationSeconds: dataBytes / byteRate }),
  };
}

function pdfInfoValue(text: string, key: string): string | undefined {
  const match = new RegExp(`\\/${key}\\s*\\(([^)]{0,1000})\\)`, "u").exec(text);
  return match?.[1]?.replace(/\\([()\\])/gu, "$1").trim() || undefined;
}

function zipMetadata(tail: Buffer): {
  readonly diskNumber: number;
  readonly entryCount: number;
  readonly centralDirectoryBytes: number;
} | undefined {
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) !== 0x06054b50) continue;
    return {
      diskNumber: tail.readUInt16LE(offset + 4),
      entryCount: tail.readUInt16LE(offset + 10),
      centralDirectoryBytes: tail.readUInt32LE(offset + 12),
    };
  }
  return undefined;
}

function archiveType(head: Buffer, fallback: string): string {
  if (head.subarray(0, 7).toString("ascii") === "Rar!\x1a\x07") return "rar";
  if (head.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) return "7z";
  if (head[0] === 0x1f && head[1] === 0x8b) return "gzip";
  if (head.subarray(257, 262).toString("ascii") === "ustar") return "tar";
  return fallback || "unknown";
}

function parseObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("ffprobe returned an invalid JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function normalizeFfprobe(value: Record<string, unknown>): JsonObject {
  const streams = Array.isArray(value["streams"])
    ? value["streams"].filter(isRecord)
    : [];
  const format = isRecord(value["format"]) ? value["format"] : {};
  const video = streams.find((stream) => stream["codec_type"] === "video");
  const audio = streams.find((stream) => stream["codec_type"] === "audio");
  const tags = isRecord(format["tags"]) ? format["tags"] : {};
  const streamTags = isRecord((video ?? audio)?.["tags"]) ? (video ?? audio)!["tags"] as Record<string, unknown> : {};
  const duration = finiteNumber(format["duration"]) ?? finiteNumber((video ?? audio)?.["duration"]);
  const frameRate = rationalNumber(video?.["avg_frame_rate"] ?? video?.["r_frame_rate"]);
  const creationTime = stringOrUndefined(tags["creation_time"]) ?? stringOrUndefined(streamTags["creation_time"]);
  return {
    container: stringOrUndefined(format["format_name"]) ?? "unknown",
    ...(duration === undefined ? {} : { durationSeconds: duration }),
    ...(video === undefined
      ? {}
      : {
          video: {
            codec: stringOrUndefined(video["codec_name"]) ?? "unknown",
            ...(finiteNumber(video["width"]) === undefined ? {} : { width: finiteNumber(video["width"])! }),
            ...(finiteNumber(video["height"]) === undefined ? {} : { height: finiteNumber(video["height"])! }),
            ...(frameRate === undefined ? {} : { frameRate }),
          },
        }),
    ...(audio === undefined
      ? {}
      : {
          audio: {
            codec: stringOrUndefined(audio["codec_name"]) ?? "unknown",
            ...(finiteNumber(audio["sample_rate"]) === undefined
              ? {}
              : { sampleRate: finiteNumber(audio["sample_rate"])! }),
            ...(finiteNumber(audio["channels"]) === undefined ? {} : { channels: finiteNumber(audio["channels"])! }),
          },
        }),
    ...(creationTime === undefined ? {} : { captureAt: creationTime }),
    ...(stringOrUndefined(tags["artist"]) === undefined ? {} : { artist: stringOrUndefined(tags["artist"])! }),
    ...(stringOrUndefined(tags["album"]) === undefined ? {} : { album: stringOrUndefined(tags["album"])! }),
    ...(stringOrUndefined(tags["title"]) === undefined ? {} : { title: stringOrUndefined(tags["title"])! }),
    ...(stringOrUndefined(tags["track"]) === undefined ? {} : { track: stringOrUndefined(tags["track"])! }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
}

function rationalNumber(value: unknown): number | undefined {
  if (typeof value !== "string") return finiteNumber(value);
  const [left, right] = value.split("/");
  const numerator = Number(left);
  const denominator = Number(right ?? 1);
  return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0
    ? numerator / denominator
    : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
