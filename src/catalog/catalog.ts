import type {
  ContentId,
  IndexedFile,
  LibraryRoot,
  LibraryRootId,
  OperationPlan,
  RootRelativePath,
} from "../domain/index.js";

export interface CatalogQuery {
  readonly libraryRootId?: LibraryRootId;
  readonly contentId?: ContentId;
  readonly pathPrefix?: RootRelativePath;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface CatalogPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

/** Storage port; a SQLite adapter will implement this contract. */
export interface CatalogStore {
  initialize(): Promise<void>;
  saveLibraryRoot(root: LibraryRoot): Promise<void>;
  getLibraryRoot(id: LibraryRootId): Promise<LibraryRoot | undefined>;
  listLibraryRoots(): Promise<readonly LibraryRoot[]>;
  saveIndexedFiles(files: readonly IndexedFile[]): Promise<void>;
  queryIndexedFiles(query: CatalogQuery): Promise<CatalogPage<IndexedFile>>;
  savePlan(plan: OperationPlan): Promise<void>;
}

export interface SqliteCatalogOptions {
  /** Must itself be resolved through an approved root boundary. */
  readonly databasePath: string;
  readonly enableWriteAheadLogging: boolean;
  readonly busyTimeoutMilliseconds: number;
}

export const SQLITE_CATALOG_IMPLEMENTATION_STATUS = "inventory-metadata-only" as const;
