import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

export function readJsonFile<T>(path: string): T | null {
  try {
    return (JSON.parse(readFileSync(path, "utf8")) as T) ?? null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function writeJsonFileAtomic(path: string, value: unknown): void {
  const json = JSON.stringify(value, null, 2);
  if (json === undefined) throw new TypeError("Value is not JSON-serializable");

  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tempPath, "w", 0o600);
    writeSync(fd, `${json}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, path);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
      }
    }
    try {
      unlinkSync(tempPath);
    } catch {
    }
    throw error;
  }
}
