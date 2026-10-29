import fs from 'node:fs';
import path from 'node:path';
import { randomToken } from './crypto.js';

/**
 * One JSON document on disk. Reads always hit the file (so a re-seed is picked up by a running
 * gateway), writes go to a temp file and are renamed into place (atomic on the same volume).
 */
export class JsonFile<T> {
  constructor(
    readonly file: string,
    private readonly empty: () => T,
  ) {}

  read(): T {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return this.empty();
      throw err;
    }
  }

  write(value: T): void {
    writeFileAtomic(this.file, JSON.stringify(value, null, 2));
  }

  update(fn: (value: T) => void): T {
    const value = this.read();
    fn(value);
    this.write(value);
    return value;
  }
}

export function writeFileAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomToken(6)}.tmp`;
  fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** In-process async lock: callers run strictly one after another. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
