export function replaceTarball(
  source: string,
  destination: string,
  temporaryTarball?: string,
): Promise<void>;

export function vendorHomeySdk(): Promise<void>;

export function sdkTarballs(directory: string): Promise<string[]>;

interface VendorRollbackOptions {
  vendorDirectory?: string;
  homeyDirectory?: string;
  write?: (path: string, contents: Uint8Array) => Promise<void>;
  remove?: (path: string, options: { force: boolean }) => Promise<void>;
  listTarballs?: (directory: string) => Promise<string[]>;
  runCommand?: (
    command: string,
    arguments_: string[],
    cwd: string,
  ) => Promise<void>;
}

export function rollback(
  originalFiles: ReadonlyMap<string, Uint8Array>,
  originalTarballs: ReadonlyMap<string, Uint8Array>,
  options?: VendorRollbackOptions,
): Promise<void>;

interface VendorLockHandle {
  close(): Promise<void>;
}

interface VendorLockOptions {
  openFile?: (
    path: string,
    flags: string,
    mode: number,
  ) => Promise<VendorLockHandle>;
  removeFile?: (path: string, options: { force: boolean }) => Promise<void>;
}

export function withVendorLock<Result>(
  operation: () => Result | Promise<Result>,
  lockPath?: string,
  options?: VendorLockOptions,
): Promise<Result>;

export function withVendorCleanup<Result>(
  operation: () => Result | Promise<Result>,
  cleanup: () => void | Promise<void>,
  message: string,
): Promise<Result>;
