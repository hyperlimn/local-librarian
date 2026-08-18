import type { IndexedFile, JsonObject } from "../domain/index.js";

export interface MediaAnalysis {
  readonly analyzerId: string;
  readonly analyzerVersion: string;
  readonly metadata: JsonObject;
  readonly analyzedAt: string;
}

/** Extracts machine-readable metadata without changing the source file. */
export interface MediaAnalyzer {
  readonly id: string;
  readonly version: string;
  supports(file: IndexedFile): boolean;
  analyze(file: IndexedFile): Promise<MediaAnalysis>;
}

