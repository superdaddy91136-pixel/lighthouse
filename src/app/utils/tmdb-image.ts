import { Channel } from '../models/channel';
import { TmdbMediaEnrichment } from '../models/tmdb';

export const TMDB_IMAGE_BASE_URL = 'https://image.tmdb.org/t/p/';

export type TmdbPosterSize = 'w185' | 'w342' | 'w500' | 'w780' | 'original';
export type TmdbBackdropSize = 'w300' | 'w780' | 'w1280' | 'original';
export type TmdbStillSize = 'w185' | 'w300' | 'original';
export type TmdbProfileSize = 'w185' | 'h632' | 'original';

/**
 * Builds a full TMDB poster URL with the requested size.
 * Returns undefined if path is missing or invalid.
 */
export function getTmdbPosterUrl(
  path?: string,
  size: TmdbPosterSize = 'w500',
): string | undefined {
  if (!path || typeof path !== 'string' || path.trim() === '') return undefined;
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${TMDB_IMAGE_BASE_URL}${size}${cleanPath}`;
}

/**
 * Builds a full TMDB backdrop URL with the requested size.
 * Returns undefined if path is missing or invalid.
 */
export function getTmdbBackdropUrl(
  path?: string,
  size: TmdbBackdropSize = 'w1280',
): string | undefined {
  if (!path || typeof path !== 'string' || path.trim() === '') return undefined;
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${TMDB_IMAGE_BASE_URL}${size}${cleanPath}`;
}

/**
 * Builds a full TMDB episode still URL with the requested size.
 * Returns undefined if path is missing or invalid.
 */
export function getTmdbStillUrl(
  path?: string,
  size: TmdbStillSize = 'w300',
): string | undefined {
  if (!path || typeof path !== 'string' || path.trim() === '') return undefined;
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${TMDB_IMAGE_BASE_URL}${size}${cleanPath}`;
}

/**
 * Builds a full TMDB cast/crew profile photo URL.
 */
export function getTmdbProfileUrl(
  path?: string,
  size: TmdbProfileSize = 'w185',
): string | undefined {
  if (!path || typeof path !== 'string' || path.trim() === '') return undefined;
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${TMDB_IMAGE_BASE_URL}${size}${cleanPath}`;
}

/**
 * Resolves artwork for an IPTV channel, prioritizing enriched TMDB artwork when available
 * with graceful fallback to the channel's original provider image.
 *
 * Never breaks provider artwork if TMDB is not enriched or artwork is missing.
 */
export function resolveMediaArtwork(
  channel?: Channel,
  enrichment?: TmdbMediaEnrichment,
  prefer: 'poster' | 'backdrop' = 'poster',
): string | undefined {
  if (enrichment) {
    if (prefer === 'backdrop' && enrichment.backdropPath) {
      const url = getTmdbBackdropUrl(enrichment.backdropPath, 'w1280');
      if (url) return url;
    }

    if (prefer === 'poster' && enrichment.posterPath) {
      const url = getTmdbPosterUrl(enrichment.posterPath, 'w500');
      if (url) return url;
    }

    // Secondary fallback within enrichment
    if (enrichment.posterPath) {
      const url = getTmdbPosterUrl(enrichment.posterPath, 'w500');
      if (url) return url;
    }

    if (enrichment.backdropPath) {
      const url = getTmdbBackdropUrl(enrichment.backdropPath, 'w780');
      if (url) return url;
    }
  }

  // Provider fallback
  return channel?.image || undefined;
}
