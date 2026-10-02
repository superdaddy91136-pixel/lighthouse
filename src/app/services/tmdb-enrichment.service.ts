import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { Channel } from '../models/channel';
import { MediaType } from '../models/mediaType';
import { TmdbMediaEnrichment, TmdbSeasonDetail } from '../models/tmdb';
import { cleanMediaTitle } from '../utils/media-presentation';
import {
  extractImdbId,
  prepareSearchQuery,
  scoreMatch,
  TMDB_MINIMUM_CONFIDENCE_THRESHOLD,
} from '../utils/tmdb-matcher';
import { TmdbCacheService } from './tmdb-cache.service';
import { TmdbConfigService } from './tmdb-config.service';
import { TmdbService } from './tmdb.service';

interface QueueItem {
  channel: Channel;
  priority: 'high' | 'normal';
}

@Injectable({
  providedIn: 'root',
})
export class TmdbEnrichmentService {
  /** Emits whenever an enrichment record is matched, updated, or refreshed */
  public enrichmentUpdated$ = new Subject<TmdbMediaEnrichment>();

  private queue: QueueItem[] = [];
  private inFlightKeys = new Set<string>();
  private activeWorkers = 0;
  private readonly MAX_CONCURRENT = 2;
  private readonly REQUEST_DELAY_MS = 200;

  constructor(
    private configService: TmdbConfigService,
    private cacheService: TmdbCacheService,
    private tmdbService: TmdbService,
  ) {}

  /**
   * Fast synchronous lookup from hot memory cache.
   * Never blocks or incurs Promise overhead.
   */
  getEnrichmentSync(channel?: Channel): TmdbMediaEnrichment | undefined {
    if (!channel?.id) return undefined;
    return this.cacheService.getEnrichmentSync(channel.id);
  }

  /**
   * Cache-first retrieval.
   * Returns cached data immediately if present (stale-while-revalidate).
   * Enqueues non-blocking background fetch if missing or stale.
   */
  async getEnrichment(
    channel: Channel,
    allowBackgroundFetch = true,
    priority: 'high' | 'normal' = 'normal',
  ): Promise<TmdbMediaEnrichment | undefined> {
    if (!channel?.id || channel.media_type === MediaType.livestream) {
      return undefined;
    }

    const cached = await this.cacheService.getEnrichment(channel.id);

    if (cached) {
      if (this.cacheService.isStale(cached) && allowBackgroundFetch && this.configService.isEnabled()) {
        this.enqueue(channel, priority);
      }
      return cached;
    }

    if (allowBackgroundFetch && this.configService.isEnabled()) {
      if (priority === 'high') {
        return new Promise<TmdbMediaEnrichment | undefined>((resolve) => {
          const sub = this.enrichmentUpdated$.subscribe((res) => {
            if (Number(res.providerItemId) === Number(channel.id)) {
              sub.unsubscribe();
              resolve(res);
            }
          });
          setTimeout(() => {
            sub.unsubscribe();
            resolve(this.cacheService.getEnrichmentSync(channel.id));
          }, 8000);

          this.enqueue(channel, 'high');
        });
      } else {
        this.enqueue(channel, priority);
      }
    }

    return undefined;
  }

  /**
   * Enqueues a channel for background TMDB enrichment.
   * Deduplicates requests and handles priority ordering.
   */
  enqueue(channel: Channel, priority: 'high' | 'normal' = 'normal'): void {
    if (!channel?.id || !this.configService.isEnabled()) return;

    const key = `ch_${channel.id}`;
    if (this.inFlightKeys.has(key)) return;

    // Check if already in queue
    const existingIdx = this.queue.findIndex(item => item.channel.id === channel.id);
    if (existingIdx !== -1) {
      if (priority === 'high' && this.queue[existingIdx].priority !== 'high') {
        this.queue.splice(existingIdx, 1);
        this.queue.unshift({ channel, priority });
      }
      return;
    }

    if (priority === 'high') {
      this.queue.unshift({ channel, priority });
    } else {
      this.queue.push({ channel, priority });
    }

    this.processQueue();
  }

  private processQueue(): void {
    if (this.activeWorkers >= this.MAX_CONCURRENT || this.queue.length === 0) {
      return;
    }

    const item = this.queue.shift();
    if (!item || !item.channel.id) return;

    const key = `ch_${item.channel.id}`;
    this.inFlightKeys.add(key);
    this.activeWorkers++;

    this.enrichWorker(item.channel, item.priority)
      .catch((err) => {
        console.warn(`Enrichment failed for channel ${item.channel.name}:`, err);
      })
      .finally(() => {
        this.inFlightKeys.delete(key);
        this.activeWorkers--;
        setTimeout(() => this.processQueue(), this.REQUEST_DELAY_MS);
      });
  }

  /**
   * Background enrichment worker executing the matching pipeline.
   */
  private async enrichWorker(channel: Channel, priority: 'high' | 'normal' = 'normal'): Promise<void> {
    if (!channel.id || !this.configService.isEnabled()) return;

    const isSeries = Number(channel.media_type) === MediaType.serie || (channel as any).series_id != null;
    const mediaType: 'movie' | 'tv' = isSeries ? 'tv' : 'movie';

    // 1. Check for IMDb ID in channel fields
    const externalImdb =
      extractImdbId(channel.name) ||
      extractImdbId(channel.url) ||
      (channel as any).stream_icon
        ? extractImdbId((channel as any).stream_icon)
        : undefined;

    if (externalImdb) {
      const findRes = await this.tmdbService.findByExternalId(externalImdb);
      const results = isSeries ? findRes?.tv_results : findRes?.movie_results;

      if (results && results.length > 0) {
        const top = results[0];
        const fullDetails = isSeries
          ? await this.tmdbService.getTvDetails(top.id)
          : await this.tmdbService.getMovieDetails(top.id);

        if (fullDetails) {
          const enrichment = isSeries
            ? this.tmdbService.parseTvDetails(fullDetails, 1.0, cleanMediaTitle(channel.name), channel.id)
            : this.tmdbService.parseMovieDetails(fullDetails, 1.0, cleanMediaTitle(channel.name), channel.id);

          await this.cacheService.saveEnrichment(enrichment);
          this.enrichmentUpdated$.next(enrichment);
          return;
        }
      }
    }

    // 2. Query preparation and title normalization
    const { query, year } = prepareSearchQuery(channel.name);
    if (!query || query.length < 2) return;

    const searchKey = `${mediaType}:${query.toLowerCase()}:${year || ''}`;

    // 3. Check negative cache (bypass on high priority to allow user detail requests to retry)
    if (priority !== 'high') {
      const isFailed = await this.cacheService.isFailedMatch(searchKey);
      if (isFailed) return;
    }

    // 4. Search TMDB
    let searchResults = isSeries
      ? await this.tmdbService.searchTv(query, year)
      : await this.tmdbService.searchMovie(query, year);

    // If search with year returned no results, retry without year constraint
    if ((!searchResults || searchResults.length === 0) && year) {
      searchResults = isSeries
        ? await this.tmdbService.searchTv(query)
        : await this.tmdbService.searchMovie(query);
    }

    // If still no results and query contains a colon (e.g. "Shaque: Trust No One"), try primary part
    if ((!searchResults || searchResults.length === 0) && query.includes(':')) {
      const primaryPart = query.split(':')[0].trim();
      if (primaryPart.length >= 2) {
        searchResults = isSeries
          ? await this.tmdbService.searchTv(primaryPart, year)
          : await this.tmdbService.searchMovie(primaryPart, year);
        if ((!searchResults || searchResults.length === 0) && year) {
          searchResults = isSeries
            ? await this.tmdbService.searchTv(primaryPart)
            : await this.tmdbService.searchMovie(primaryPart);
        }
      }
    }

    if (!searchResults || searchResults.length === 0) {
      await this.cacheService.recordFailedMatch(searchKey, query, mediaType, year);
      return;
    }

    // 5. Score candidates
    const scored = searchResults.map((cand) => ({
      candidate: cand,
      score: scoreMatch(cand, query, year),
    }));

    if (query.includes(':')) {
      const primaryPart = query.split(':')[0].trim();
      for (const s of scored) {
        const altScore = scoreMatch(s.candidate, primaryPart, year);
        if (altScore.confidence > s.score.confidence) {
          s.score = altScore;
        }
      }
    }

    scored.sort((a, b) => b.score.confidence - a.score.confidence);
    const best = scored[0];

    // 6. Check confidence threshold
    if (!best || best.score.confidence < TMDB_MINIMUM_CONFIDENCE_THRESHOLD) {
      await this.cacheService.recordFailedMatch(searchKey, query, mediaType, year);
      return;
    }

    // 7. Fetch full details for the best match
    const full = isSeries
      ? await this.tmdbService.getTvDetails(best.candidate.id)
      : await this.tmdbService.getMovieDetails(best.candidate.id);

    if (!full) {
      return;
    }

    const enrichment = isSeries
      ? this.tmdbService.parseTvDetails(full, best.score.confidence, query, channel.id)
      : this.tmdbService.parseMovieDetails(full, best.score.confidence, query, channel.id);

    await this.cacheService.saveEnrichment(enrichment);
    this.enrichmentUpdated$.next(enrichment);
  }

  /**
   * Fetches TV season details with cache-first strategy.
   */
  async getSeasonDetails(
    tmdbId: number,
    seasonNumber: number,
  ): Promise<TmdbSeasonDetail | undefined> {
    const cached = await this.cacheService.getSeasonDetail(tmdbId, seasonNumber);
    if (cached && !this.cacheService.isStale(cached as any, 14 * 24 * 60 * 60 * 1000)) {
      return cached;
    }

    if (!this.configService.isEnabled()) return cached;

    const raw = await this.tmdbService.getTvSeasonDetails(tmdbId, seasonNumber);
    if (!raw) return cached;

    const parsed = this.tmdbService.parseSeasonDetails(raw, tmdbId);
    await this.cacheService.saveSeasonDetail(parsed);
    return parsed;
  }
}
