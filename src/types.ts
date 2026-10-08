export type ScanStatus = "unscanned" | "scanning" | "complete" | "partial" | "error";

export interface Entry {
  id: string;
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
}

export interface SpaceNode extends Entry {
  // Directory size is always an aggregate of verified file sizes, never list.size.
  status: ScanStatus;
  children: SpaceNode[];
  listed: boolean;
  fileCount: number;
  directoryCount: number;
  error?: string;
  scannedAt?: string;
}

export interface ListPage {
  entries: Entry[];
  hasMore: boolean;
}

export interface DiskAdapter {
  list(path: string, page: number, signal?: AbortSignal): Promise<ListPage>;
}

export interface ScanProgress {
  directoriesRead: number;
  filesFound: number;
  requests: number;
  currentPath: string;
}

export interface SavedScan {
  version: 1;
  savedAt: string;
  // Bound cache to account; do not restore one user's paths into another account.
  accountId: string;
  root: SpaceNode;
}
