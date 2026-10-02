import { Injectable } from '@angular/core';
import {
  TmdbCastMember,
  TmdbEpisodeDetail,
  TmdbMediaEnrichment,
  TmdbSeasonDetail,
  TmdbVideo,
} from '../models/tmdb';
import { TmdbConfigService } from './tmdb-config.service';

const TMDB_API_BASE = 'https://api.themoviedb.org/3';
const REQUEST_TIMEOUT_MS = 10000;

@Injectable({
  providedIn: 'root',
})
export class TmdbService {
  constructor(private configService: TmdbConfigService) {}

  private getAuthHeader(): { Authorization: string; Accept: string } | null {
    const token = this.configService.getToken()?.trim();
    if (!token) return null;
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };
  }

  /**
   * Safe fetch wrapper with timeout, bearer token auth, and error handling.
   */
  private async safeGet<T>(endpoint: string, params?: Record<string, string | number | undefined>): Promise<T | null> {
    const headers = this.getAuthHeader();
    if (!headers) return null;

    let url = `${TMDB_API_BASE}${endpoint}`;
    if (params) {
      const searchParams = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== '') {
          searchParams.append(k, String(v));
        }
      }
      const qs = searchParams.toString();
      if (qs) url += `?${qs}`;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      const res = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (res.status === 401) {
        console.warn('TMDB API Token is invalid or expired (401)');
        return null;
      }

      if (res.status === 404) {
        return null;
      }

      if (res.status === 429) {
        console.warn('TMDB API rate limit reached (429)');
        return null;
      }

      if (!res.ok) {
        console.warn(`TMDB request failed with HTTP ${res.status} for ${endpoint}`);
        return null;
      }

      return (await res.json()) as T;
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        console.warn(`TMDB fetch error for ${endpoint}:`, err?.message || err);
      }
      return null;
    }
  }

  /**
   * Search for movies matching query and optional release year.
   */
  async searchMovie(query: string, year?: string): Promise<any[]> {
    if (!query || query.trim().length === 0) return [];
    const data = await this.safeGet<any>('/search/movie', {
      query: query.trim(),
      primary_release_year: year,
      include_adult: 'false',
    });
    return data?.results || [];
  }

  /**
   * Search for TV shows matching query and optional first air date year.
   */
  async searchTv(query: string, year?: string): Promise<any[]> {
    if (!query || query.trim().length === 0) return [];
    const data = await this.safeGet<any>('/search/tv', {
      query: query.trim(),
      first_air_date_year: year,
      include_adult: 'false',
    });
    return data?.results || [];
  }

  /**
   * Find media by external ID (e.g. IMDb ID 'tt1234567').
   */
  async findByExternalId(externalId: string, externalSource: 'imdb_id' = 'imdb_id'): Promise<any | null> {
    if (!externalId) return null;
    return await this.safeGet<any>(`/find/${encodeURIComponent(externalId)}`, {
      external_source: externalSource,
    });
  }

  /**
   * Fetch full movie details including credits and videos (trailers).
   */
  async getMovieDetails(movieId: number): Promise<any | null> {
    return await this.safeGet<any>(`/movie/${movieId}`, {
      append_to_response: 'credits,videos',
    });
  }

  /**
   * Fetch full TV show details including credits and videos.
   */
  async getTvDetails(tvId: number): Promise<any | null> {
    return await this.safeGet<any>(`/tv/${tvId}`, {
      append_to_response: 'credits,videos',
    });
  }

  /**
   * Fetch season details for a TV show, including episode metadata.
   */
  async getTvSeasonDetails(tvId: number, seasonNumber: number): Promise<any | null> {
    return await this.safeGet<any>(`/tv/${tvId}/season/${seasonNumber}`);
  }

  /**
   * Parses raw TMDB movie details into our normalized detail-screen ready model.
   */
  parseMovieDetails(
    raw: any,
    matchConfidence: number,
    normalizedTitle: string,
    providerItemId?: number,
  ): TmdbMediaEnrichment {
    const cast: TmdbCastMember[] = (raw.credits?.cast || [])
      .slice(0, 10)
      .map((c: any) => ({
        id: c.id,
        name: c.name,
        character: c.character,
        profilePath: c.profile_path,
      }));

    const directorMember = (raw.credits?.crew || []).find(
      (cr: any) => cr.job === 'Director',
    );

    const trailers: TmdbVideo[] = (raw.videos?.results || [])
      .filter((v: any) => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser'))
      .slice(0, 3)
      .map((v: any) => ({
        id: v.id,
        key: v.key,
        name: v.name,
        site: v.site,
        type: v.type,
        official: v.official,
      }));

    const genres: string[] = (raw.genres || []).map((g: any) => g.name);
    const releaseYear = raw.release_date && raw.release_date.length >= 4 ? raw.release_date.substring(0, 4) : undefined;

    return {
      providerItemId,
      tmdbId: raw.id,
      mediaType: 'movie',
      normalizedTitle,
      matchedTitle: raw.title || raw.original_title || normalizedTitle,
      originalTitle: raw.original_title,
      matchConfidence,
      overview: raw.overview?.trim() || undefined,
      posterPath: raw.poster_path || undefined,
      backdropPath: raw.backdrop_path || undefined,
      releaseDate: raw.release_date || undefined,
      releaseYear,
      genres: genres.length > 0 ? genres : undefined,
      rating: raw.vote_average ? Math.round(raw.vote_average * 10) / 10 : undefined,
      voteCount: raw.vote_count,
      runtime: raw.runtime || undefined,
      tagline: raw.tagline?.trim() || undefined,
      cast: cast.length > 0 ? cast : undefined,
      director: directorMember?.name,
      imdbId: raw.imdb_id,
      originalLanguage: raw.original_language || undefined,
      trailers: trailers.length > 0 ? trailers : undefined,
      lastUpdated: Date.now(),
    };
  }

  /**
   * Parses raw TMDB TV show details into our normalized detail-screen ready model.
   */
  parseTvDetails(
    raw: any,
    matchConfidence: number,
    normalizedTitle: string,
    providerItemId?: number,
  ): TmdbMediaEnrichment {
    const cast: TmdbCastMember[] = (raw.credits?.cast || [])
      .slice(0, 14)
      .map((c: any) => ({
        id: c.id,
        name: c.name,
        character: c.character,
        profilePath: c.profile_path,
      }));

    const trailers: TmdbVideo[] = (raw.videos?.results || [])
      .filter((v: any) => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser'))
      .sort((a: any, b: any) => {
        if (a.type === 'Trailer' && b.type !== 'Trailer') return -1;
        if (b.type === 'Trailer' && a.type !== 'Trailer') return 1;
        if (a.official && !b.official) return -1;
        if (b.official && !a.official) return 1;
        return 0;
      })
      .slice(0, 3)
      .map((v: any) => ({
        id: v.id,
        key: v.key,
        name: v.name,
        site: v.site,
        type: v.type,
        official: v.official,
      }));

    const genres: string[] = (raw.genres || []).map((g: any) => g.name);
    const releaseYear = raw.first_air_date && raw.first_air_date.length >= 4 ? raw.first_air_date.substring(0, 4) : undefined;
    const runtime = raw.episode_run_time && raw.episode_run_time.length > 0 ? raw.episode_run_time[0] : undefined;

    return {
      providerItemId,
      tmdbId: raw.id,
      mediaType: 'tv',
      normalizedTitle,
      matchedTitle: raw.name || raw.original_name || normalizedTitle,
      originalTitle: raw.original_name,
      matchConfidence,
      overview: raw.overview?.trim() || undefined,
      posterPath: raw.poster_path || undefined,
      backdropPath: raw.backdrop_path || undefined,
      releaseDate: raw.first_air_date || undefined,
      releaseYear,
      genres: genres.length > 0 ? genres : undefined,
      rating: raw.vote_average ? Math.round(raw.vote_average * 10) / 10 : undefined,
      voteCount: raw.vote_count,
      runtime,
      tagline: raw.tagline?.trim() || undefined,
      cast: cast.length > 0 ? cast : undefined,
      trailers: trailers.length > 0 ? trailers : undefined,
      numberOfSeasons: raw.number_of_seasons,
      numberOfEpisodes: raw.number_of_episodes,
      lastAirDate: raw.last_air_date || undefined,
      status: raw.status || undefined,
      creator: (raw.created_by && raw.created_by.length > 0)
        ? raw.created_by.map((c: any) => c.name).join(', ')
        : undefined,
      originalLanguage: raw.original_language || undefined,
      lastUpdated: Date.now(),
    };
  }

  /**
   * Parses raw TMDB season details into normalized model.
   */
  parseSeasonDetails(raw: any, tmdbId: number): TmdbSeasonDetail {
    const episodes: TmdbEpisodeDetail[] = (raw.episodes || []).map((ep: any) => ({
      id: ep.id,
      episodeNumber: ep.episode_number,
      seasonNumber: ep.season_number,
      name: ep.name,
      overview: ep.overview?.trim() || undefined,
      stillPath: ep.still_path || undefined,
      airDate: ep.air_date || undefined,
      voteAverage: ep.vote_average ? Math.round(ep.vote_average * 10) / 10 : undefined,
      runtime: ep.runtime || undefined,
    }));

    return {
      id: raw.id,
      tmdbId,
      seasonNumber: raw.season_number,
      name: raw.name,
      overview: raw.overview?.trim() || undefined,
      posterPath: raw.poster_path || undefined,
      airDate: raw.air_date || undefined,
      episodeCount: episodes.length,
      episodes,
      lastUpdated: Date.now(),
    };
  }
}
