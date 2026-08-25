import type { InventoryRecord } from "../domain/index.js";

const EXTENSION_CATEGORIES: Readonly<Record<string, string>> = Object.freeze({
  // Documents and office files
  pdf: "Documents", doc: "Documents", docx: "Documents", odt: "Documents",
  rtf: "Documents", txt: "Documents", md: "Documents", tex: "Documents",
  pages: "Documents", ppt: "Documents", pptx: "Documents", odp: "Documents",
  xls: "Spreadsheets", xlsx: "Spreadsheets", ods: "Spreadsheets", csv: "Spreadsheets",
  // Photos and graphics
  jpg: "Images", jpeg: "Images", png: "Images", gif: "Images", webp: "Images",
  heic: "Images", heif: "Images", tif: "Images", tiff: "Images", bmp: "Images",
  svg: "Images", ico: "Images", raw: "Images", dng: "Images", cr2: "Images",
  nef: "Images", avif: "Images",
  // Video and audio
  mp4: "Videos", mov: "Videos", mkv: "Videos", avi: "Videos", webm: "Videos",
  m4v: "Videos", mpg: "Videos", mpeg: "Videos", wmv: "Videos", flv: "Videos",
  mp3: "Audio", wav: "Audio", flac: "Audio", m4a: "Audio", aac: "Audio",
  ogg: "Audio", opus: "Audio", wma: "Audio", aiff: "Audio",
  // Archives, disk images, and backups
  zip: "Archives", rar: "Archives", sevenz: "Archives", "7z": "Archives",
  tar: "Archives", gz: "Archives", bz2: "Archives", xz: "Archives", tgz: "Archives",
  iso: "Archives", dmg: "Archives", bak: "Archives",
  // Books and fonts
  epub: "Books", mobi: "Books", azw: "Books", azw3: "Books", cbz: "Books",
  cbr: "Books", ttf: "Fonts", otf: "Fonts", woff: "Fonts", woff2: "Fonts",
  // Code and structured data
  js: "Code", jsx: "Code", ts: "Code", tsx: "Code", py: "Code", rb: "Code",
  rs: "Code", go: "Code", java: "Code", c: "Code", h: "Code", cpp: "Code",
  cs: "Code", swift: "Code", kt: "Code", sh: "Code", ps1: "Code", html: "Code",
  css: "Code", scss: "Code", sql: "Code", yaml: "Data", yml: "Data",
  json: "Data", xml: "Data", toml: "Data", sqlite: "Data", db: "Data",
  parquet: "Data", ndjson: "Data", jsonl: "Data",
  // Installers and packages
  exe: "Applications", msi: "Applications", app: "Applications", apk: "Applications",
  deb: "Applications", rpm: "Applications", pkg: "Applications", appimage: "Applications",
  // Common project and design formats
  psd: "Design", ai: "Design", sketch: "Design", fig: "Design", xcf: "Design",
  dwg: "Design", dxf: "Design", blend: "Design", stl: "Design", obj: "Design",
});

export function categorizeInventoryFile(record: InventoryRecord): string {
  const extension = record.extension?.toLocaleLowerCase("en-US");
  if (extension === undefined || extension.length === 0) return "Other";
  return EXTENSION_CATEGORIES[extension] ?? "Other";
}

export function knownOrganizationCategories(): readonly string[] {
  return [...new Set(Object.values(EXTENSION_CATEGORIES)), "Other"].sort();
}
