export interface KeysetSource {
  /** Full keyset ids the mint knows (all, including inactive). Throws if the mint cannot be reached. */
  ids(opts?: { refresh?: boolean }): Promise<string[]>;
}

/** GET {mintUrl}/v1/keysets, cached in memory. */
export class HttpKeysetSource implements KeysetSource {
  private cache?: string[];
  constructor(private mintUrl: string, private fetchImpl: typeof fetch = fetch) {}

  async ids(opts: { refresh?: boolean } = {}): Promise<string[]> {
    if (this.cache && !opts.refresh) return this.cache;
    const res = await this.fetchImpl(`${this.mintUrl.replace(/\/+$/, "")}/v1/keysets`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`keysets request failed: HTTP ${res.status}`);
    const body = (await res.json()) as { keysets?: { id: string; unit?: string }[] };
    this.cache = (body.keysets ?? []).filter((k) => !k.unit || k.unit === "usd").map((k) => k.id);
    return this.cache;
  }
}

/** Fixed list, for tests. */
export class StaticKeysetSource implements KeysetSource {
  constructor(private list: string[]) {}
  async ids(): Promise<string[]> {
    return this.list;
  }
}
