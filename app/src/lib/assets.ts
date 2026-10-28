// Parano1d v2.1 tokens and NFTs held by this wallet's address.
//
// The wallet server only passes on records; the core decodes and checks every
// one (core/src/assets.rs). Names, tickers and pictures are public metadata,
// checked against the hash in the token's or NFT's record. Like the NOID
// balance, the records themselves are trusted from the server for now (see
// REVIEW.md), so these screens only display: nothing is signed from them.
import { Directory, File, Paths } from 'expo-file-system';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { ApiError, type Api } from './api';
import { core, CoreError, type AssetManifest, type CheckedAssets, type CheckedNft, type CheckedToken, type MediaKind, type TokenInfo } from './core';

export interface Token extends CheckedToken {
  info: TokenInfo | null;
  manifest: AssetManifest | null;
}

export interface Nft extends CheckedNft {
  manifest: AssetManifest | null;
}

export interface Assets {
  address: string;
  height: number;
  tokens: Token[];
  nfts: Nft[];
  collections: number;
  other: number;
  complete: boolean;
  loadedAt: number;
}

export type AssetsState =
  | { kind: 'idle' }
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string; last: Assets | null }
  | { kind: 'ready'; assets: Assets };

/** Reload at most this often unless the user pulls to refresh. */
const MIN_RELOAD_MS = 60_000;
const MEDIA_DIR = 'asset-media';

let state: AssetsState = { kind: 'idle' };
let inflight: Promise<void> | null = null;
/** Last load attempt, so a failing or unsupported server isn't asked every block. */
let lastAttempt = { address: '', at: 0 };
/** Bumped when the wallet is removed or the address changes: older loads are dropped. */
let generation = 0;
let inflightAddress = '';
/** A token's market and name change rarely: reuse them for a while. */
const INFO_MS = 10 * 60_000;
/** Look up names and prices for at most this many tokens (others show their ID). */
const MAX_TOKEN_LOOKUPS = 50;
const infoCache = new Map<string, { at: number; info: TokenInfo | null; manifest: AssetManifest | null }>();
const PICTURE_TIMEOUT_MS = 30_000;
const listeners = new Set<() => void>();

function set(next: AssetsState) {
  state = next;
  for (const l of listeners) l();
}

function lastAssets(): Assets | null {
  return state.kind === 'ready' ? state.assets : state.kind === 'error' ? state.last : null;
}

function mediaDir(): Directory {
  const d = new Directory(Paths.cache, MEDIA_DIR);
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  return d;
}

/** Checked metadata, from the phone's cache or the server. Null if unavailable. */
async function manifestFor(api: Api, hash: string, kind: MediaKind): Promise<AssetManifest | null> {
  const cached = new File(mediaDir(), `${hash}.json`);
  try {
    if (cached.exists) return await core.checkMetadata(hash, cached.textSync(), kind);
  } catch {
    try {
      cached.delete();
    } catch {
      // ignore
    }
  }
  try {
    const { text } = await api.mediaMetadata(hash);
    const manifest = await core.checkMetadata(hash, text, kind);
    try {
      cached.create({ overwrite: true });
      cached.write(text);
    } catch {
      // cache is optional
    }
    return manifest;
  } catch {
    // Missing, unavailable or not the committed details: show the ID instead.
    return null;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function load(api: Api, address: string): Promise<Assets> {
  const page = await api.assets(address);
  const checked: CheckedAssets = await core.checkAssets(address, page);
  const tokens = await mapLimit(checked.tokens, 4, async (t, i): Promise<Token> => {
    const cached = infoCache.get(t.assetId);
    if (cached && Date.now() - cached.at < INFO_MS) return { ...t, info: cached.info, manifest: cached.manifest };
    if (i >= MAX_TOKEN_LOOKUPS) return { ...t, info: null, manifest: null };
    let info: TokenInfo | null = null;
    try {
      info = await core.checkToken(t.assetId, await api.asset(t.assetId));
    } catch {
      info = null;
    }
    const manifest = info?.known ? await manifestFor(api, info.metadata, 'token') : null;
    if (info) {
      if (infoCache.size > 500) infoCache.clear();
      infoCache.set(t.assetId, { at: Date.now(), info, manifest });
    }
    return { ...t, info, manifest };
  });
  const nfts = await mapLimit(checked.nfts, 4, async (n): Promise<Nft> => ({ ...n, manifest: await manifestFor(api, n.metadata, 'nft') }));
  return {
    address,
    height: checked.height,
    tokens,
    nfts,
    collections: checked.collections,
    other: checked.other,
    complete: page.complete,
    loadedAt: Date.now(),
  };
}

export const assets = {
  get: () => state,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
  /** Load (or reload) the holdings of `address`. Cheap to call often. */
  refresh(api: Api, address: string, opts: { force?: boolean } = {}): Promise<void> {
    const last = lastAssets();
    if ((last && last.address !== address) || (inflight && inflightAddress !== address)) {
      // Another wallet: forget the old one and drop its load still running.
      generation++;
      inflight = null;
      set({ kind: 'idle' });
    }
    const recent = lastAttempt.address === address && Date.now() - lastAttempt.at < MIN_RELOAD_MS;
    if (inflight) return inflight;
    if (recent && !opts.force) return Promise.resolve();
    lastAttempt = { address, at: Date.now() };
    const gen = generation;
    inflightAddress = address;
    const run: Promise<void> = load(api, address)
      .then((a) => {
        if (gen === generation) set({ kind: 'ready', assets: a });
      })
      .catch((e: unknown) => {
        if (gen !== generation) return;
        if (e instanceof ApiError && e.code === 'assets_unsupported') return set({ kind: 'unsupported' });
        const message =
          e instanceof CoreError
            ? 'The wallet server sent token records this wallet could not check.'
            : e instanceof Error
              ? e.message
              : 'Tokens could not be loaded.';
        const prev = lastAssets();
        set({ kind: 'error', message, last: prev && prev.address === address ? prev : null });
      })
      .finally(() => {
        if (inflight === run) inflight = null;
      });
    inflight = run;
    return run;
  },
  /** Forget everything (wallet removed). */
  clear() {
    generation++;
    inflight = null;
    infoCache.clear();
    set({ kind: 'idle' });
    lastAttempt = { address: '', at: 0 };
    pictures.clear();
    try {
      const d = new Directory(Paths.cache, MEDIA_DIR);
      if (d.exists) d.delete();
    } catch {
      // nothing cached
    }
  },
};

export function useAssets(): AssetsState {
  return useSyncExternalStore(assets.subscribe, assets.get);
}

/** The checked holdings of `address` to show (also while a reload failed). */
export function shownAssets(s: AssetsState, address: string | undefined): Assets | null {
  const a = s.kind === 'ready' ? s.assets : s.kind === 'error' ? s.last : null;
  return a && address && a.address === address ? a : null;
}

const pictures = new Map<string, Promise<string | null>>();

/**
 * Local file of a checked picture, downloading it if needed. Null when it is
 * unavailable or is not exactly the picture the token committed to.
 */
export function pictureFor(api: Api, image: NonNullable<AssetManifest['image']>): Promise<string | null> {
  let p = pictures.get(image.hash);
  if (!p) {
    p = (async () => {
      const dir = mediaDir();
      const final = new File(dir, `${image.hash}.png`);
      if (final.exists && final.size === image.bytes) return final.uri;
      const tmp = new File(dir, `${image.hash}.part`);
      // Stop a download that runs too long or grows past the committed size.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PICTURE_TIMEOUT_MS);
      try {
        if (tmp.exists) tmp.delete();
        await File.downloadFileAsync(api.mediaImageUrl(image.hash), tmp, {
          idempotent: true,
          signal: controller.signal,
          onProgress: ({ bytesWritten, totalBytes }) => {
            if (bytesWritten > image.bytes || totalBytes > image.bytes) controller.abort();
          },
        });
        // A plain path for the core (no file:// prefix or %-escapes).
        await core.checkImage(decodeURIComponent(tmp.uri.replace(/^file:\/\//, '')), image);
        tmp.move(final, { overwrite: true });
        return final.uri;
      } catch {
        try {
          if (tmp.exists) tmp.delete();
        } catch {
          // ignore
        }
        return null;
      } finally {
        clearTimeout(timer);
      }
    })();
    pictures.set(image.hash, p);
    // A failure can be retried later (the server may have been offline).
    void p.then((uri) => {
      if (!uri) pictures.delete(image.hash);
    });
  }
  return p;
}

export function usePicture(api: Api, image: AssetManifest['image'] | undefined): string | null {
  const [got, setGot] = useState<{ hash: string; uri: string | null } | null>(null);
  const hash = image?.hash;
  useEffect(() => {
    let live = true;
    if (image) void pictureFor(api, image).then((uri) => live && setGot({ hash: image.hash, uri }));
    return () => {
      live = false;
    };
  }, [api, hash]); // eslint-disable-line react-hooks/exhaustive-deps
  // Only the picture of the asset shown now (never the previous one while loading).
  return got && got.hash === hash ? got.uri : null;
}

export function tokenName(t: Token): string {
  return t.manifest?.name ?? 'Unnamed token';
}

export function nftName(n: Nft): string {
  return n.manifest?.name ?? `NFT #${n.serial}`;
}
