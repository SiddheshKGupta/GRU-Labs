// Ledger persistence. The state directory is T1 property: AVL refuses to
// open an episode whose state directory sits inside the workspace a Minion
// can write (see assertOutsideWorkspace).

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, isAbsolute, resolve } from "node:path";
import { sha256 } from "./canonical.ts";

export interface LedgerStore {
  append(line: string): void;
  lines(): string[];
  putBlob(bytes: string | Uint8Array): string;
  getBlob(digest: string): Uint8Array | undefined;
}

export class MemoryStore implements LedgerStore {
  readonly #lines: string[] = [];
  readonly #blobs = new Map<string, Uint8Array>();

  append(line: string): void {
    this.#lines.push(line);
  }

  lines(): string[] {
    return [...this.#lines];
  }

  putBlob(bytes: string | Uint8Array): string {
    const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
    const digest = sha256(data);
    this.#blobs.set(digest, data);
    return digest;
  }

  getBlob(digest: string): Uint8Array | undefined {
    return this.#blobs.get(digest);
  }

  /** Test hook for tamper scenarios: replace one stored line. */
  tamper(index: number, line: string): void {
    this.#lines[index] = line;
  }
}

export class FileStore implements LedgerStore {
  readonly #ledgerPath: string;
  readonly #blobDir: string;

  constructor(stateDir: string, episodeId: string) {
    const episodeDir = join(stateDir, "episodes", episodeId);
    this.#blobDir = join(stateDir, "blobs");
    mkdirSync(episodeDir, { recursive: true });
    mkdirSync(this.#blobDir, { recursive: true });
    this.#ledgerPath = join(episodeDir, "ledger.jsonl");
  }

  static open(stateDir: string, episodeId: string): FileStore {
    const path = join(stateDir, "episodes", episodeId, "ledger.jsonl");
    if (!existsSync(path)) throw new Error(`no ledger for episode ${episodeId} in ${stateDir}`);
    return new FileStore(stateDir, episodeId);
  }

  append(line: string): void {
    appendFileSync(this.#ledgerPath, `${line}\n`, "utf8");
  }

  lines(): string[] {
    if (!existsSync(this.#ledgerPath)) return [];
    return readFileSync(this.#ledgerPath, "utf8").split("\n").filter((line) => line.length > 0);
  }

  putBlob(bytes: string | Uint8Array): string {
    const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
    const digest = sha256(data);
    const path = join(this.#blobDir, digest);
    if (!existsSync(path)) writeFileSync(path, data);
    return digest;
  }

  getBlob(digest: string): Uint8Array | undefined {
    if (!/^[0-9a-f]{64}$/.test(digest)) return undefined;
    const path = join(this.#blobDir, digest);
    return existsSync(path) ? new Uint8Array(readFileSync(path)) : undefined;
  }
}

export function listEpisodes(stateDir: string): string[] {
  const dir = join(stateDir, "episodes");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

/** Refuse a state directory the Minion could write through its workspace (P2, P5). */
export function assertOutsideWorkspace(stateDir: string, workspaceRoot: string): string {
  mkdirSync(stateDir, { recursive: true });
  const state = realpathSync(resolve(stateDir));
  const workspace = realpathSync(resolve(workspaceRoot));
  for (const [inner, outer] of [[state, workspace], [workspace, state]] as const) {
    const rel = relative(outer, inner);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
      throw new Error(
        `state directory ${state} and workspace ${workspace} overlap; ` +
          "the ledger must live where the Minion cannot write",
      );
    }
  }
  return state;
}
