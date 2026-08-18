import type {
  ApprovedLibraryRoot,
  IndexedFile,
  LibraryRoot,
  RootRelativePath,
} from "../domain/index.js";

export interface ScanOptions {
  readonly hashContent: boolean;
  readonly includeHidden: boolean;
  readonly maximumDepth?: number;
}

export type ScanEvent =
  | { readonly kind: "scan-started"; readonly root: LibraryRoot }
  | { readonly kind: "directory-observed"; readonly path: RootRelativePath }
  | { readonly kind: "file-observed"; readonly file: IndexedFile }
  | {
      readonly kind: "entry-skipped";
      readonly path: RootRelativePath;
      readonly reason: string;
    }
  | { readonly kind: "scan-completed"; readonly fileCount: number };

/** Read-only port. Implementations must receive an already approved root. */
export interface LibraryScanner {
  scan(root: ApprovedLibraryRoot, options: ScanOptions): AsyncIterable<ScanEvent>;
}
