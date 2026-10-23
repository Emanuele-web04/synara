import fs from "node:fs";
import path from "node:path";

export interface RotatingFileSinkOptions {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly throwOnError?: boolean;
  readonly mode?: number;
  /**
   * Keep one append descriptor open between writes instead of opening and
   * closing the file for every chunk. It is reopened after rotation and after a
   * failed write. Call `close()` when the sink is no longer used.
   */
  readonly keepFileOpen?: boolean;
}

export class RotatingFileSink {
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly throwOnError: boolean;
  private readonly mode: number | undefined;
  private readonly keepFileOpen: boolean;
  private fd: number | null = null;
  private currentSize = 0;

  constructor(options: RotatingFileSinkOptions) {
    if (options.maxBytes < 1) {
      throw new Error(`maxBytes must be >= 1 (received ${options.maxBytes})`);
    }
    if (options.maxFiles < 1) {
      throw new Error(`maxFiles must be >= 1 (received ${options.maxFiles})`);
    }

    this.filePath = options.filePath;
    this.maxBytes = options.maxBytes;
    this.maxFiles = options.maxFiles;
    this.throwOnError = options.throwOnError ?? false;
    this.mode = options.mode;
    this.keepFileOpen = options.keepFileOpen ?? false;

    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.pruneOverflowBackups();
    this.currentSize = this.readCurrentSize();
  }

  write(chunk: string | Buffer): void {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (buffer.length === 0) return;

    try {
      if (this.currentSize > 0 && this.currentSize + buffer.length > this.maxBytes) {
        this.rotate();
      }

      if (this.keepFileOpen) {
        this.writeToOpenFile(buffer);
      } else if (this.mode === undefined) {
        fs.appendFileSync(this.filePath, buffer);
      } else {
        fs.appendFileSync(this.filePath, buffer, { mode: this.mode });
      }
      this.currentSize += buffer.length;

      if (this.currentSize > this.maxBytes) {
        this.rotate();
      }
    } catch {
      this.closeFile();
      this.currentSize = this.readCurrentSize();
      if (this.throwOnError) {
        throw new Error(`Failed to write log chunk to ${this.filePath}`);
      }
    }
  }

  /** Releases the open descriptor, if any. Later writes reopen the file. */
  close(): void {
    this.closeFile();
  }

  private writeToOpenFile(buffer: Buffer): void {
    if (this.fd === null) {
      this.fd =
        this.mode === undefined
          ? fs.openSync(this.filePath, "a")
          : fs.openSync(this.filePath, "a", this.mode);
    }
    let offset = 0;
    while (offset < buffer.length) {
      const written = fs.writeSync(this.fd, buffer, offset, buffer.length - offset);
      if (written <= 0) {
        throw new Error(`Short write to ${this.filePath}`);
      }
      offset += written;
    }
  }

  private closeFile(): void {
    const fd = this.fd;
    if (fd === null) return;
    this.fd = null;
    try {
      fs.closeSync(fd);
    } catch {
      // The descriptor is unusable either way; the next write reopens the file.
    }
  }

  private rotate(): void {
    try {
      // Close before renaming so the next write opens the fresh base file.
      this.closeFile();
      const oldest = this.withSuffix(this.maxFiles);
      if (fs.existsSync(oldest)) {
        fs.rmSync(oldest, { force: true });
      }

      for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
        const source = this.withSuffix(index);
        const target = this.withSuffix(index + 1);
        if (fs.existsSync(source)) {
          fs.renameSync(source, target);
        }
      }

      if (fs.existsSync(this.filePath)) {
        fs.renameSync(this.filePath, this.withSuffix(1));
      }

      this.currentSize = 0;
    } catch {
      this.currentSize = this.readCurrentSize();
      if (this.throwOnError) {
        throw new Error(`Failed to rotate log file ${this.filePath}`);
      }
    }
  }

  private pruneOverflowBackups(): void {
    try {
      const dir = path.dirname(this.filePath);
      const baseName = path.basename(this.filePath);
      for (const entry of fs.readdirSync(dir)) {
        if (!entry.startsWith(`${baseName}.`)) continue;
        const suffix = Number(entry.slice(baseName.length + 1));
        if (!Number.isInteger(suffix) || suffix <= this.maxFiles) continue;
        fs.rmSync(path.join(dir, entry), { force: true });
      }
    } catch {
      if (this.throwOnError) {
        throw new Error(`Failed to prune log backups for ${this.filePath}`);
      }
    }
  }

  private readCurrentSize(): number {
    try {
      return fs.statSync(this.filePath).size;
    } catch {
      return 0;
    }
  }

  private withSuffix(index: number): string {
    return `${this.filePath}.${index}`;
  }
}
