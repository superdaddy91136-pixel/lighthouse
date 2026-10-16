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
   * Fetch trending movies for discovery from TMDB.
   */
  async getTrendingMovies(timeWindow: 'day' | 'week' = 'week'): Promise<any[]> {
    const data = await this.safeGet<any>(`/trending/movie/${timeWindow}`);
    return data?.results || [];
  }

  /**
   * Fetch trending TV shows for discovery from TMDB.
   */
  async getTrendingTv(timeWindow: 'day' | 'week' = 'week'): Promise<any[]> {
    const data = await this.safeGet<any>(`/trending/tv/${timeWindow}`);
    return data?.results || [];
  }

  /**
   * Fetch Korean TV shows from TMDB discover.
   */
  async getKoreanTv(page: number = 1): Promise<any[]> {
    const data = await this.safeGet<any>('/discover/tv', {
      with_original_language: 'ko',
      sort_by: 'popularity.desc',
      page,
    });
    return data?.results || [];
  }

  /**
   * Fetch popular movies from TMDB.
   */
  async getPopularMovies(page: number = 1): Promise<any[]> {
    const data = await this.safeGet<any>('/movie/popular', {
      page,
      include_adult: 'false',
    });
    return data?.results || [];
  }

  /**
   * Fetch popular TV shows from TMDB.
   */
  async getPopularTv(page: number = 1): Promise<any[]> {
    const data = await this.safeGet<any>('/tv/popular', {
      page,
      include_adult: 'false',
    });
    return data?.results || [];
  }

  /**
   * Fetch top rated movies from TMDB.
   */
  async getTopRatedMovies(page: number = 1): Promise<any[]> {
    const data = await this.safeGet<any>('/movie/top_rated', {
      page,
      include_adult: 'false',
    });
    return data?.results || [];
  }

  /**
   * Fetch top rated TV shows from TMDB.
   */
  async getTopRatedTv(page: number = 1): Promise<any[]> {
    const data = await this.safeGet<any>('/tv/top_rated', {
      page,
      include_adult: 'false',
    });
    return data?.results || [];
  }

  /**
   * Custom discover query for movies (e.g. genre filter, minimum votes, sorting).
   */
  async discoverMovies(params: Record<string, string | number | undefined> = {}): Promise<any[]> {
    const data = await this.safeGet<any>('/discover/movie', {
      include_adult: 'false',
      sort_by: 'popularity.desc',
      ...params,
    });
    return data?.results || [];
  }

  /**
   * Custom discover query for TV shows (e.g. genre filter, minimum votes, sorting).
   */
  async discoverTv(params: Record<string, string | number | undefined> = {}): Promise<any[]> {
    const data = await this.safeGet<any>('/discover/tv', {
      include_adult: 'false',
      sort_by: 'popularity.desc',
      ...params,
    });
    return data?.results || [];
  }

  /**
   * Get movie recommendations based on a seed movie ID.
   */
  async getMovieRecommendations(movieId: number, page: number = 1): Promise<any[]> {
    if (!movieId) return [];
    const data = await this.safeGet<any>(`/movie/${movieId}/recommendations`, { page });
    return data?.results || [];
  }

  /**
   * Get TV show recommendations based on a seed TV show ID.
   */
  async getTvRecommendations(tvId: number, page: number = 1): Promise<any[]> {
    if (!tvId) return [];
    const data = await this.safeGet<any>(`/tv/${tvId}/recommendations`, { page });
    return data?.results || [];
  }

  /**
   * Get similar movies based on a seed movie ID.
   */
  async getSimilarMovies(movieId: number, page: number = 1): Promise<any[]> {
    if (!movieId) return [];
    const data = await this.safeGet<any>(`/movie/${movieId}/similar`, { page });
    return data?.results || [];
  }

  /**
   * Get similar TV shows based on a seed TV show ID.
   */
  async getSimilarTv(tvId: number, page: number = 1): Promise<any[]> {
    if (!tvId) return [];
    const data = await this.safeGet<any>(`/tv/${tvId}/similar`, { page });
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
      append_to_response: 'credits,videos,images',
    });
  }

  /**
   * Fetch full TV show details including credits and videos.
   */
  async getTvDetails(tvId: number): Promise<any | null> {
    return await this.safeGet<any>(`/tv/${tvId}`, {
      append_to_response: 'credits,videos,images',
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
    const logoPath = extractBestLogoPath(raw.images);
    const backdropPath = extractBestBackdropPath(raw.backdrop_path, raw.images);

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
      backdropPath,
      logoPath,
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
      originCountry: Array.isArray(raw.origin_country)
        ? raw.origin_country
        : (raw.production_countries || []).map((p: any) => p.iso_3166_1).filter(Boolean),
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
    const logoPath = extractBestLogoPath(raw.images);
    const backdropPath = extractBestBackdropPath(raw.backdrop_path, raw.images);

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
      backdropPath,
      logoPath,
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
      originCountry: Array.isArray(raw.origin_country)
        ? raw.origin_country
        : (raw.production_countries || []).map((p: any) => p.iso_3166_1).filter(Boolean),
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

/**
 * Selects the best title logo path from TMDB raw.images?.logos.
 * Prefers English ('en') or language-neutral logos, followed by vote/rating score.
 */
function extractBestLogoPath(images: any): string | undefined {
  const logos: any[] = images?.logos;
  if (!logos || !Array.isArray(logos) || logos.length === 0) {
    return undefined;
  }
  const valid = logos.filter(
    (l) => l && typeof l.file_path === 'string' && l.file_path.trim() !== '',
  );
  if (valid.length === 0) return undefined;

  const scored = [...valid].sort((a, b) => {
    const aLang = a.iso_639_1 === 'en' ? 2 : (!a.iso_639_1 ? 1 : 0);
    const bLang = b.iso_639_1 === 'en' ? 2 : (!b.iso_639_1 ? 1 : 0);
    if (aLang !== bLang) return bLang - aLang;

    const aScore = (a.vote_average || 0) * (a.vote_count || 1);
    const bScore = (b.vote_average || 0) * (b.vote_count || 1);
    if (aScore !== bScore) return bScore - aScore;

    return (b.width || 0) - (a.width || 0);
  });

  return scored[0]?.file_path || undefined;
}

/**
 * Selects the best backdrop path from raw TMDB details.
 * Prefers raw.backdrop_path if available; otherwise falls back to the highest-scored
 * backdrop in raw.images?.backdrops (preferring English/neutral, high resolution, high vote).
 */
function extractBestBackdropPath(primaryBackdrop: any, images: any): string | undefined {
  if (primaryBackdrop && typeof primaryBackdrop === 'string' && primaryBackdrop.trim() !== '') {
    return primaryBackdrop;
  }
  const backdrops: any[] = images?.backdrops;
  if (!backdrops || !Array.isArray(backdrops) || backdrops.length === 0) {
    return undefined;
  }
  const valid = backdrops.filter(
    (b) => b && typeof b.file_path === 'string' && b.file_path.trim() !== '',
  );
  if (valid.length === 0) return undefined;

  const scored = [...valid].sort((a, b) => {
    // Prefer language-neutral or English backdrops
    const aLang = !a.iso_639_1 ? 2 : (a.iso_639_1 === 'en' ? 1 : 0);
    const bLang = !b.iso_639_1 ? 2 : (b.iso_639_1 === 'en' ? 1 : 0);
    if (aLang !== bLang) return bLang - aLang;

    // Prefer higher resolution (e.g. 1920 or 3840 wide)
    const aWidth = a.width || 0;
    const bWidth = b.width || 0;
    if (aWidth !== bWidth) return bWidth - aWidth;

    // Prefer higher vote score
    const aScore = (a.vote_average || 0) * (a.vote_count || 1);
    const bScore = (b.vote_average || 0) * (b.vote_count || 1);
    return bScore - aScore;
  });

  return scored[0]?.file_path || undefined;
}

