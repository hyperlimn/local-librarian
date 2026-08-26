import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ArchiveMetadataAnalyzer,
  AudioTagAnalyzer,
  DocumentMetadataAnalyzer,
  FfprobeMediaAnalyzer,
  ImageMetadataAnalyzer,
  type FfprobeExecutor,
  type HashTask,
} from "../../src/intelligence/index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("local metadata analyzers", () => {
  it("extracts TIFF EXIF capture, orientation, and camera metadata locally", async () => {
    const directory = await tempDirectory();
    const filePath = path.join(directory, "capture.tiff");
    const fixture = tiffWithExif();
    await writeFile(filePath, fixture);

    const result = await new ImageMetadataAnalyzer().analyze(
      task("capture.tiff", "tiff", fixture.byteLength),
      filePath,
    );

    expect(result).toMatchObject({
      status: "completed",
      facts: {
        format: "TIFF",
        captureDateOriginal: "2024:07:04 12:34:56",
        captureAt: "2024-07-04T12:34:56",
        orientation: 6,
        cameraMake: "Codex",
      },
    });
    expect(JSON.stringify(result)).not.toContain("http");
  });

  it("extracts safe PDF, WAVE, and ZIP structure without extraction or rendering", async () => {
    const directory = await tempDirectory();
    const pdf = Buffer.from(
      "%PDF-1.7\n/Title (Local Report) /Author (A. Librarian) /Type /Page /Type /Page\n%%EOF",
      "latin1",
    );
    const wave = waveFixture();
    const zip = zipEndOfCentralDirectory(3, 120);
    const pdfPath = path.join(directory, "report.pdf");
    const wavePath = path.join(directory, "song.wav");
    const zipPath = path.join(directory, "archive.zip");
    await Promise.all([
      writeFile(pdfPath, pdf),
      writeFile(wavePath, wave),
      writeFile(zipPath, zip),
    ]);

    const document = await new DocumentMetadataAnalyzer().analyze(
      task("report.pdf", "pdf", pdf.byteLength),
      pdfPath,
    );
    const audio = await new AudioTagAnalyzer().analyze(
      task("song.wav", "wav", wave.byteLength),
      wavePath,
    );
    const archive = await new ArchiveMetadataAnalyzer().analyze(
      task("archive.zip", "zip", zip.byteLength),
      zipPath,
    );

    expect(document).toMatchObject({
      status: "completed",
      facts: { format: "PDF", title: "Local Report", author: "A. Librarian", pageCount: 2 },
    });
    expect(audio).toMatchObject({
      status: "completed",
      facts: {
        format: "WAVE",
        channels: 2,
        sampleRate: 48_000,
        bitsPerSample: 16,
        durationSeconds: 1,
      },
    });
    expect(archive).toMatchObject({
      status: "completed",
      facts: {
        archiveType: "zip",
        entryCount: 3,
        centralDirectoryBytes: 120,
        inspectedWithoutExtraction: true,
      },
    });
  });

  it("degrades cleanly when ffprobe is absent and normalizes structured media output when present", async () => {
    const unavailable = new FfprobeMediaAnalyzer(new RejectingFfprobe());
    await expect(unavailable.analyze(task("clip.mov", "mov", 100), "/unused")).resolves.toEqual({
      status: "unavailable",
      facts: { prerequisite: "ffprobe" },
      warnings: ["ffprobe is not installed; basic local tags remain available where supported."],
    });

    const available = new FfprobeMediaAnalyzer(new FixtureFfprobe());
    const result = await available.analyze(task("clip.mov", "mov", 100), "/local/clip.mov");
    expect(result).toMatchObject({
      status: "completed",
      facts: {
        container: "mov,mp4",
        durationSeconds: 12.5,
        captureAt: "2024-07-04T12:34:56Z",
        video: { codec: "h264", width: 1920, height: 1080 },
        audio: { codec: "aac", sampleRate: 48000, channels: 2 },
      },
    });
    if (result.status !== "completed") throw new Error("Expected completed ffprobe output.");
    const video = result.facts["video"] as Record<string, unknown>;
    expect(video["frameRate"]).toBeCloseTo(29.97, 2);
  });
});

class RejectingFfprobe implements FfprobeExecutor {
  public execute(): Promise<string> {
    return Promise.reject(new Error("ENOENT"));
  }
}

class FixtureFfprobe implements FfprobeExecutor {
  public execute(arguments_: readonly string[]): Promise<string> {
    if (arguments_.includes("-version")) return Promise.resolve("ffprobe version fixture");
    return Promise.resolve(JSON.stringify({
      streams: [
        {
          codec_type: "video",
          codec_name: "h264",
          width: 1920,
          height: 1080,
          avg_frame_rate: "30000/1001",
        },
        {
          codec_type: "audio",
          codec_name: "aac",
          sample_rate: "48000",
          channels: 2,
        },
      ],
      format: {
        format_name: "mov,mp4",
        duration: "12.5",
        tags: { creation_time: "2024-07-04T12:34:56Z" },
      },
    }));
  }
}

function task(name: string, extension: string, byteLength: number): HashTask {
  return {
    recordId: "record",
    rootId: "root",
    scanId: "scan",
    relativePath: name,
    name,
    extension,
    byteLength,
  };
}

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "local-librarian-analyzers-"));
  directories.push(directory);
  return directory;
}

function tiffWithExif(): Buffer {
  const value = Buffer.alloc(94);
  value.write("II", 0, "ascii");
  value.writeUInt16LE(42, 2);
  value.writeUInt32LE(8, 4);
  value.writeUInt16LE(3, 8);

  writeIfdEntry(value, 10, 0x0112, 3, 1, 6);
  writeIfdEntry(value, 22, 0x010f, 2, 6, 50);
  writeIfdEntry(value, 34, 0x8769, 4, 1, 56);
  value.writeUInt32LE(0, 46);
  value.write("Codex\0", 50, "ascii");

  value.writeUInt16LE(1, 56);
  writeIfdEntry(value, 58, 0x9003, 2, 20, 74);
  value.writeUInt32LE(0, 70);
  value.write("2024:07:04 12:34:56\0", 74, "ascii");
  return value;
}

function writeIfdEntry(
  buffer: Buffer,
  offset: number,
  tag: number,
  type: number,
  count: number,
  value: number,
): void {
  buffer.writeUInt16LE(tag, offset);
  buffer.writeUInt16LE(type, offset + 2);
  buffer.writeUInt32LE(count, offset + 4);
  if (type === 3 && count === 1) {
    buffer.writeUInt16LE(value, offset + 8);
    buffer.writeUInt16LE(0, offset + 10);
  } else {
    buffer.writeUInt32LE(value, offset + 8);
  }
}

function waveFixture(): Buffer {
  const value = Buffer.alloc(44 + 192_000);
  value.write("RIFF", 0, "ascii");
  value.writeUInt32LE(value.byteLength - 8, 4);
  value.write("WAVE", 8, "ascii");
  value.write("fmt ", 12, "ascii");
  value.writeUInt32LE(16, 16);
  value.writeUInt16LE(1, 20);
  value.writeUInt16LE(2, 22);
  value.writeUInt32LE(48_000, 24);
  value.writeUInt32LE(192_000, 28);
  value.writeUInt16LE(4, 32);
  value.writeUInt16LE(16, 34);
  value.write("data", 36, "ascii");
  value.writeUInt32LE(192_000, 40);
  return value;
}

function zipEndOfCentralDirectory(entryCount: number, centralDirectoryBytes: number): Buffer {
  const value = Buffer.alloc(22);
  value.writeUInt32LE(0x06054b50, 0);
  value.writeUInt16LE(entryCount, 8);
  value.writeUInt16LE(entryCount, 10);
  value.writeUInt32LE(centralDirectoryBytes, 12);
  return value;
}
