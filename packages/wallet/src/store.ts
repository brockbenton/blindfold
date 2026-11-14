import { closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { open, readFile, rename, unlink, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { WireProof } from "@blindfold/protocol";
import { TokenFileError } from "./errors.js";

export interface PendingWire {
  proofs: WireProof[];
  url: string;
  sent_at: number;
}

/** Token file (00 section 3.4) in JSON form: amounts are numbers. Unknown fields are preserved. */
export interface StoredFile {
  version: 1;
  mint: string;
  unit: "usd";
  proofs: WireProof[];
  pending?: PendingWire[];
  [extra: string]: unknown;
}

export interface TokenStore {
  read(): Promise<StoredFile>;
  write(f: StoredFile): Promise<void>;
}

export function validateFile(raw: unknown): StoredFile {
  if (typeof raw !== "object" || raw === null) throw new TokenFileError("token file is not an object");
  const f = raw as Record<string, unknown>;
  if (f.version !== 1) throw new TokenFileError(`unsupported token file version ${String(f.version)}`);
  if (f.unit !== "usd") throw new TokenFileError(`unsupported unit ${String(f.unit)}`);
  if (typeof f.mint !== "string" || !f.mint) throw new TokenFileError("token file has no mint");
  if (!Array.isArray(f.proofs)) throw new TokenFileError("token file has no proofs array");
  const seen = new Set<string>();
  const clean = (arr: unknown[]): WireProof[] => {
    const out: WireProof[] = [];
    for (const p of arr as Record<string, unknown>[]) {
      if (typeof p?.secret !== "string" || typeof p.C !== "string" || typeof p.id !== "string") throw new TokenFileError("malformed proof in token file");
      const amount = Number(p.amount);
      if (!Number.isSafeInteger(amount) || amount <= 0) throw new TokenFileError("bad proof amount in token file");
      if (seen.has(p.secret)) continue;
      seen.add(p.secret);
      const { witness: _w, ...rest } = p;
      out.push({ ...(rest as unknown as WireProof), amount });
    }
    return out;
  };
  const proofs = clean(f.proofs);
  let pending: PendingWire[] | undefined;
  if (f.pending !== undefined) {
    if (!Array.isArray(f.pending)) throw new TokenFileError("pending is not an array");
    pending = (f.pending as PendingWire[]).map((e) => ({ url: String(e.url), sent_at: Number(e.sent_at), proofs: clean(e.proofs ?? []) }));
  }
  const out = { ...f, proofs } as StoredFile;
  if (pending) out.pending = pending;
  return out;
}

/** Atomic write: temp file in the same directory, fsync, rename. Mode 0600. */
export async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  const fh = await open(tmp, "w", 0o600);
  try {
    await fh.writeFile(JSON.stringify(data, null, 2));
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

export class FileTokenStore implements TokenStore {
  private lockPath: string;
  private held = false;
  private onExit = () => this.releaseSync();

  constructor(public readonly path: string) {
    this.lockPath = `${path}.lock`;
  }

  async read(): Promise<StoredFile> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (e) {
      throw new TokenFileError(`cannot read token file ${this.path}: ${(e as Error).message}`);
    }
    try {
      return validateFile(JSON.parse(text));
    } catch (e) {
      if (e instanceof TokenFileError) throw e;
      throw new TokenFileError(`token file ${this.path} is not valid JSON`);
    }
  }

  write(f: StoredFile): Promise<void> {
    return atomicWriteJson(this.path, f);
  }

  /** Advisory single-process lock (`<file>.lock`, pid inside). A lock whose pid is dead is stale. */
  acquireLock(): void {
    mkdirSync(dirname(this.lockPath), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(this.lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        writeSync(fd, String(process.pid));
        fsyncSync(fd);
        closeSync(fd);
        this.held = true;
        process.once("exit", this.onExit);
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const pid = Number.parseInt(readFileSync(this.lockPath, "utf8"), 10);
        if (Number.isInteger(pid) && alive(pid) && pid !== process.pid) throw new TokenFileError(`token file is locked by pid ${pid}`);
        if (pid === process.pid) throw new TokenFileError("token file is already open in this process");
        try { unlinkSync(this.lockPath); } catch { /* raced */ }
      }
    }
    throw new TokenFileError("could not take the token file lock");
  }

  releaseSync(): void {
    if (!this.held) return;
    this.held = false;
    process.removeListener("exit", this.onExit);
    if (existsSync(this.lockPath)) try { unlinkSync(this.lockPath); } catch { /* gone */ }
  }
}
