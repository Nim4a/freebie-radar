import type { HttpClient } from "../http.ts";

export type RawItem = {
  externalId: string;
  url: string;
  title: string;
  summary?: string | null;
  author?: string | null;
  publishedAt?: string | null;
  expiresAt?: string | null;
  tags?: string[];
  /** structured category hint supplied by the source (e.g. a GitHub list's section name) */
  categoryHint?: string | null;
  /** Per-feed content-kind fallback; cannot bypass source-level fixed classification. */
  kindHint?: string | null;
  /** full body text (optional, used to extract redemption codes and to keep a record in case the original post is deleted) */
  content?: string | null;
  /** cover / thumbnail URL (optional; legal http(s) addresses only) */
  imageUrl?: string | null;
  raw?: unknown;
};

export type SourceSeed = {
  id: string;
  name: string;
  kind: string;
  enabled?: boolean;
  /** collection interval in seconds. Smaller is more timely; code-giveaway sources suggest 60-120 seconds */
  intervalSec?: number;
  config?: Record<string, unknown>;
};

export type CollectContext = {
  sourceId: string;
  config: Record<string, unknown>;
  cursor: string | null;
  maxItems: number;
  http: HttpClient;
  log: (message: string) => void;
};

export type CollectResult = {
  items: RawItem[];
  /** start of the next collection (page token / last item id) */
  cursor?: string | null;
  /** on partial success, the reason for the degradation, e.g. one board returned 403 */
  degraded?: string | null;
};

export type Collector = {
  kind: string;
  label: string;
  defaults?: { config?: Record<string, unknown>; enabled?: boolean };
  collect(ctx: CollectContext): Promise<CollectResult>;
};
