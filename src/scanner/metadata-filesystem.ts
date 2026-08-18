import { lstat, opendir } from "node:fs/promises";
import type { BigIntStats, Dir, Dirent } from "node:fs";

export interface InventoryDirectoryHandle extends AsyncIterable<Dirent> {
  close(): Promise<void>;
}

/** Deliberately exposes metadata operations only—there is no content-read API. */
export interface InventoryMetadataFilesystem {
  openDirectory(path: string, bufferSize: number): Promise<InventoryDirectoryHandle>;
  lstat(path: string): Promise<BigIntStats>;
}

export class NodeInventoryMetadataFilesystem
  implements InventoryMetadataFilesystem
{
  public openDirectory(path: string, bufferSize: number): Promise<Dir> {
    return opendir(path, { bufferSize });
  }

  public lstat(path: string): Promise<BigIntStats> {
    return lstat(path, { bigint: true });
  }
}

