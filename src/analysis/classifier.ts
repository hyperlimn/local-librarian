import type { FileKind, IndexedFile, JsonObject } from "../domain/index.js";

export interface FileClassification {
  readonly kind: FileKind;
  readonly labels: readonly string[];
  readonly confidence: number;
  readonly evidence: JsonObject;
}

/** Analysis-only plugin; classifiers never choose or mutate filesystem paths. */
export interface FileClassifier {
  readonly id: string;
  readonly version: string;
  supports(file: IndexedFile): boolean;
  classify(file: IndexedFile): Promise<FileClassification>;
}

