import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { Channel } from '../models/channel';
import { DiscoveryRow, HeroItem } from '../models/discovery';

export type DiscoveryPipelineStatus = 'idle' | 'loading' | 'success' | 'refreshing' | 'error';

export interface HomeDiscoverySnapshot {
  tmdbRows: DiscoveryRow[];
  masterHeroItems: HeroItem[];
  allRecommended: Channel[];
  allLoadedMovies: Channel[];
  allLoadedSeries: Channel[];
  timestamp: number;
  status: DiscoveryPipelineStatus;
}

@Injectable({
  providedIn: 'root',
})
export class HomeDiscoveryStateService {
  /** Emits whenever new discovery rows or hero items are successfully updated/refreshed */
  public discoveryUpdated$ = new Subject<HomeDiscoverySnapshot>();

  /** 30-minute freshness TTL for TMDB recommendation rows */
  public readonly CACHE_TTL_MS = 30 * 60 * 1000;

  /** Stored in-memory snapshot surviving navigation across tabs and routes */
  private snapshot: HomeDiscoverySnapshot | null = null;

  /** Fast in-memory cache of resolved catalog matches: `${isTv ? 'tv' : 'mv'}_${tmdbId}` -> Channel */
  private resolvedCatalogMatches: Map<string, Channel> = new Map();

  /** Concurrency & deduplication tracking */
  private inFlightPipelinePromise: Promise<void> | null = null;
  private currentRunId: number = 0;
  private lastSourceKey: string = '';

  constructor() {}

  /**
   * Checks whether valid TMDB-generated discovery data exists in the in-memory cache.
   */
  public hasValidTmdbData(): boolean {
    if (!this.snapshot) return false;
    const hasRows =
      Array.isArray(this.snapshot.tmdbRows) &&
      this.snapshot.tmdbRows.length > 0 &&
      this.snapshot.tmdbRows.some((r) =>
        r.id === 'row-recommended' ||
        r.id === 'row-popular-movies' ||
        r.id === 'row-popular-series' ||
        r.id === 'row-trending-movies' ||
        r.id === 'row-trending-series' ||
        r.id === 'row-anime-animation' ||
        r.id === 'row-korean-series'
      );
    return hasRows;
  }

  /**
   * Checks if the cached TMDB data is within the freshness threshold.
   */
  public isFresh(maxAgeMs: number = this.CACHE_TTL_MS): boolean {
    if (!this.snapshot || !this.hasValidTmdbData()) return false;
    return Date.now() - this.snapshot.timestamp < maxAgeMs;
  }

  /**
   * Retrieves the current snapshot if available.
   */
  public getSnapshot(): HomeDiscoverySnapshot | null {
    return this.snapshot;
  }

  /**
   * Retrieves cached TMDB rows (defensively copied).
   */
  public getCachedTmdbRows(): DiscoveryRow[] {
    if (!this.snapshot?.tmdbRows) return [];
    return this.snapshot.tmdbRows.map((r) => ({ ...r, items: [...r.items] }));
  }

  /**
   * Retrieves cached hero candidate items.
   */
  public getCachedHeroPool(): HeroItem[] {
    if (!this.snapshot?.masterHeroItems) return [];
    return [...this.snapshot.masterHeroItems];
  }

  public getAllRecommended(): Channel[] {
    return this.snapshot?.allRecommended ? [...this.snapshot.allRecommended] : [];
  }

  public getAllLoadedMovies(): Channel[] {
    return this.snapshot?.allLoadedMovies ? [...this.snapshot.allLoadedMovies] : [];
  }

  public getAllLoadedSeries(): Channel[] {
    return this.snapshot?.allLoadedSeries ? [...this.snapshot.allLoadedSeries] : [];
  }

  /**
   * Upserts or updates a single TMDB discovery row in the cached snapshot.
   */
  public upsertTmdbRow(row: DiscoveryRow): void {
    if (!this.snapshot) {
      this.snapshot = {
        tmdbRows: [row],
        masterHeroItems: [],
        allRecommended: [],
        allLoadedMovies: [],
        allLoadedSeries: [],
        timestamp: Date.now(),
        status: 'refreshing',
      };
      return;
    }

    const idx = this.snapshot.tmdbRows.findIndex((r) => r.id === row.id);
    if (idx !== -1) {
      this.snapshot.tmdbRows[idx] = row;
    } else {
      this.snapshot.tmdbRows.push(row);
    }
  }

  /**
   * Sets curated genre rows in the cached snapshot.
   */
  public setGenreRows(genreRows: DiscoveryRow[]): void {
    if (!this.snapshot) return;
    this.snapshot.tmdbRows = this.snapshot.tmdbRows.filter(
      (r) => !r.id.startsWith('row-genre-')
    );
    this.snapshot.tmdbRows.push(...genreRows);
  }

  /**
   * Updates hero candidate pool.
   */
  public setHeroPool(heroItems: HeroItem[]): void {
    if (!this.snapshot) {
      this.snapshot = {
        tmdbRows: [],
        masterHeroItems: [...heroItems],
        allRecommended: [],
        allLoadedMovies: [],
        allLoadedSeries: [],
        timestamp: Date.now(),
        status: 'refreshing',
      };
      return;
    }
    this.snapshot.masterHeroItems = [...heroItems];
  }

  public setLoadedPools(
    movies: Channel[],
    series: Channel[],
    recommended: Channel[]
  ): void {
    if (this.snapshot) {
      this.snapshot.allLoadedMovies = movies;
      this.snapshot.allLoadedSeries = series;
      this.snapshot.allRecommended = recommended;
    }
  }

  /**
   * Commits a successful pipeline execution, updates the timestamp, and notifies subscribers.
   */
  public markPipelineSuccess(
    tmdbRows: DiscoveryRow[],
    heroPool: HeroItem[],
    recommended: Channel[],
    movies: Channel[],
    series: Channel[]
  ): void {
    this.snapshot = {
      tmdbRows: tmdbRows.map((r) => ({ ...r, items: [...r.items] })),
      masterHeroItems: [...heroPool],
      allRecommended: [...recommended],
      allLoadedMovies: [...movies],
      allLoadedSeries: [...series],
      timestamp: Date.now(),
      status: 'success',
    };
    this.discoveryUpdated$.next(this.snapshot);
  }

  /**
   * Pipeline in-flight status and deduplication.
   */
  public isPipelineRunning(): boolean {
    return this.inFlightPipelinePromise !== null;
  }

  public getInFlightPipeline(): Promise<void> | null {
    return this.inFlightPipelinePromise;
  }

  public setInFlightPipeline(promise: Promise<void> | null): void {
    this.inFlightPipelinePromise = promise;
  }

  public startNewRun(): number {
    return ++this.currentRunId;
  }

  public getCurrentRunId(): number {
    return this.currentRunId;
  }

  /**
   * Validates if active enabled source IDs match the cached source set.
   * If source configuration changed, automatically resets the cache.
   */
  public checkSourceConsistency(sourceIds: number[]): boolean {
    const key = [...sourceIds].sort((a, b) => a - b).join(',');
    if (this.lastSourceKey && this.lastSourceKey !== key) {
      this.clearCache();
    }
    this.lastSourceKey = key;
    return true;
  }

  /**
   * Catalog match fast memory lookup.
   */
  public getCachedCatalogMatch(tmdbId: number, isTv: boolean): Channel | undefined {
    return this.resolvedCatalogMatches.get(`${isTv ? 'tv' : 'mv'}_${tmdbId}`);
  }

  public setCachedCatalogMatch(tmdbId: number, isTv: boolean, channel: Channel): void {
    if (channel && channel.id) {
      this.resolvedCatalogMatches.set(`${isTv ? 'tv' : 'mv'}_${tmdbId}`, channel);
    }
  }

  /**
   * Clears state on full catalog reload / source changes.
   */
  public clearCache(): void {
    this.snapshot = null;
    this.resolvedCatalogMatches.clear();
    this.inFlightPipelinePromise = null;
    this.currentRunId++;
  }
}
