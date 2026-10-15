import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  EventEmitter,
  HostListener,
  OnDestroy,
  OnInit,
  Output,
} from "@angular/core";
import { invoke } from "@tauri-apps/api/core";
import { ToastrService } from "ngx-toastr";
import { Subscription } from "rxjs";
import { MemoryService } from "../../memory.service";
import { Channel } from "../../models/channel";
import { DiscoveryRow, HeroItem } from "../../models/discovery";
import { Filters } from "../../models/filters";
import { MediaType } from "../../models/mediaType";
import { NavTab } from "../../models/navTab";
import { SortType } from "../../models/sortType";
import { Source } from "../../models/source";
import { ViewMode } from "../../models/viewMode";
import {
  cleanCategoryTitle,
  cleanMediaTitle,
  extractQuality,
  extractYear,
  selectSynopsis,
} from "../../utils/media-presentation";
import {
  calculateDiceSimilarity,
  calculateTokenSimilarity,
  normalizeForComparison,
} from "../../utils/tmdb-matcher";
import { TmdbEnrichmentService } from "../../services/tmdb-enrichment.service";
import { TmdbConfigService } from "../../services/tmdb-config.service";
import { getTmdbBackdropUrl, getTmdbPosterUrl, getTmdbLogoUrl, getTmdbStillUrl } from "../../utils/tmdb-image";
import { TmdbMediaEnrichment } from "../../models/tmdb";
import { MovieDetailService } from "../../services/movie-detail.service";
import { TvDetailService } from "../../services/tv-detail.service";
import { VersionMatchingService } from "../../services/version-matching.service";
import { TmdbCacheService } from "../../services/tmdb-cache.service";
import {
  HomeDiscoverySnapshot,
  HomeDiscoveryStateService,
} from "../../services/home-discovery-state.service";

export type ContentPreference = 'all' | 'english' | 'hindi' | 'korean';

export interface MixedGenreDef {
  id: string;
  title: string;
  icon: string;
  patterns: RegExp[];
  tmdbGenres: string[];
}

export const MIXED_GENRES: MixedGenreDef[] = [
  {
    id: "action-adventure",
    title: "Action & Adventure",
    icon: "bookmark",
    patterns: [/\b(action|adventure|martial\s*arts)\b/i],
    tmdbGenres: ["action", "adventure"],
  },
  {
    id: "drama-romance",
    title: "Drama & Romance",
    icon: "bookmark",
    patterns: [/\b(drama|romance|romantic)\b/i],
    tmdbGenres: ["drama", "romance"],
  },
  {
    id: "crime-thriller",
    title: "Crime & Thriller",
    icon: "bookmark",
    patterns: [/\b(crime|thriller|gangster|heist)\b/i],
    tmdbGenres: ["crime", "thriller"],
  },
  {
    id: "comedy-romance",
    title: "Comedy & Romance",
    icon: "bookmark",
    patterns: [/\b(comedy|romance|rom-?com|comic)\b/i],
    tmdbGenres: ["comedy", "romance"],
  },
  {
    id: "scifi-fantasy",
    title: "Sci-Fi & Fantasy",
    icon: "bookmark",
    patterns: [/\b(sci-?fi|science\s*fiction|fantasy|superhero)\b/i],
    tmdbGenres: ["science fiction", "fantasy", "sci-fi & fantasy"],
  },
  {
    id: "horror-thriller",
    title: "Horror & Thriller",
    icon: "bookmark",
    patterns: [/\b(horror|thriller|spooky|terror)\b/i],
    tmdbGenres: ["horror", "thriller"],
  },
  {
    id: "animation-family",
    title: "Animation & Family",
    icon: "bookmark",
    patterns: [/\b(animation|anime|cartoon|family|kids|children)\b/i],
    tmdbGenres: ["animation", "family", "kids"],
  },
  {
    id: "mystery-suspense",
    title: "Mystery & Suspense",
    icon: "bookmark",
    patterns: [/\b(mystery|suspense|detective|spy|espionage)\b/i],
    tmdbGenres: ["mystery", "suspense"],
  },
];

@Component({
  selector: "app-home-discovery",
  templateUrl: "./home-discovery.component.html",
  styleUrl: "./home-discovery.component.css",
})
export class HomeDiscoveryComponent implements OnInit, AfterViewInit, OnDestroy {
  @Output() play = new EventEmitter<Channel>();
  @Output() resume = new EventEmitter<Channel>();
  @Output() openSeries = new EventEmitter<Channel>();
  @Output() navigateTab = new EventEmitter<NavTab>();

  heroItems: HeroItem[] = [];
  masterHeroItems: HeroItem[] = [];
  currentHeroIndex: number = 0;
  discoveryRows: DiscoveryRow[] = [];
  masterDiscoveryRows: DiscoveryRow[] = [];
  loading: boolean = true;
  hasAnyContent: boolean = false;
  groupsMap: Map<number, string> = new Map();
  imageErrorSet: Set<number> = new Set();
  isHeroHovered: boolean = false;

  selectedContentPref: ContentPreference = 'all';

  // State tracking for row horizontal overflow / scroll arrows
  rowCanScrollRight: { [rowId: string]: boolean } = {};
  private resizeObserver?: ResizeObserver;

  // Hero pool state & transition
  isTransitioning: boolean = false;
  allLoadedMovies: Channel[] = [];
  allLoadedSeries: Channel[] = [];
  allRecommended: Channel[] = [];
  private transitionTimeout?: any;

  // Continue Watching deduplication & state tracking
  groupedHistoryIds: Map<number, number[]> = new Map();
  loadedSeries: Channel[] = [];
  seriesNameMap: Map<string, string> = new Map();
  episodeStillMap: Map<number, string> = new Map();
  private inFlightStillFetches: Set<number> = new Set();

  private heroTimer?: any;
  private subs: Subscription[] = [];
  private isDestroyed: boolean = false;

  constructor(
    public memory: MemoryService,
    private toastr: ToastrService,
    public tmdbEnrichment: TmdbEnrichmentService,
    public tmdbConfig: TmdbConfigService,
    public tmdbCache: TmdbCacheService,
    public discoveryState: HomeDiscoveryStateService,
    private movieDetailService: MovieDetailService,
    private tvDetailService: TvDetailService,
    public versionMatching: VersionMatchingService,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    const savedPref = localStorage.getItem("fred_tv_home_content_pref") as ContentPreference | null;
    if (savedPref && ["all", "english", "hindi", "korean"].includes(savedPref)) {
      this.selectedContentPref = savedPref;
    }

    this.subs.push(
      this.discoveryState.discoveryUpdated$.subscribe((snapshot) => {
        if (this.isDestroyed) return;
        this.syncFromSnapshot(snapshot);
      }),
    );

    this.loadDiscovery();

    this.subs.push(
      this.memory.Refresh.subscribe(() => {
        this.loadDiscovery(true);
      }),
    );

    // Subscribe to TMDB background enrichment updates
    this.subs.push(
      this.tmdbEnrichment.enrichmentUpdated$.subscribe((enrichment) => {
        if (this.isDestroyed) return;
        this.applyEnrichmentUpdate(enrichment);
      }),
    );

    this.startHeroTimer();
  }

  ngAfterViewInit(): void {
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        this.checkAllRowsScrollState();
      });
      const container = document.querySelector('.discovery-rows-container');
      if (container) {
        this.resizeObserver.observe(container);
      }
    }
    setTimeout(() => this.checkAllRowsScrollState(), 100);
    setTimeout(() => this.checkAllRowsScrollState(), 500);
  }

  ngOnDestroy(): void {
    this.isDestroyed = true;
    this.stopHeroTimer();
    if (this.transitionTimeout) {
      clearTimeout(this.transitionTimeout);
      this.transitionTimeout = undefined;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = undefined;
    }
    this.subs.forEach((s) => s.unsubscribe());
  }

  startHeroTimer() {
    this.stopHeroTimer();
    this.heroTimer = setInterval(() => {
      if (!this.isHeroHovered && this.heroItems.length > 1) {
        this.nextHero();
      }
    }, 9000);
  }

  stopHeroTimer() {
    if (this.heroTimer) {
      clearInterval(this.heroTimer);
      this.heroTimer = undefined;
    }
  }

  onHeroMouseEnter() {
    this.isHeroHovered = true;
  }

  onHeroMouseLeave() {
    this.isHeroHovered = false;
  }

  get currentHero(): HeroItem | undefined {
    if (this.heroItems.length === 0) return undefined;
    return this.heroItems[this.currentHeroIndex];
  }

  setHeroIndex(index: number) {
    if (index >= 0 && index < this.heroItems.length) {
      this.currentHeroIndex = index;
    }
  }

  nextHero() {
    if (this.heroItems.length <= 1) return;
    this.isTransitioning = true;

    if (this.transitionTimeout) {
      clearTimeout(this.transitionTimeout);
    }

    this.transitionTimeout = setTimeout(() => {
      const nextIndex = this.currentHeroIndex + 1;
      if (nextIndex >= this.heroItems.length) {
        // Full pool cycle complete!
        // Re-shuffle to keep subsequent cycles fresh,
        // and ensure the new first item is not identical to the last shown item.
        const lastShownId = this.heroItems[this.currentHeroIndex]?.channel?.id;
        const reshuffled = this.shufflePool(this.heroItems);
        if (reshuffled.length > 1 && reshuffled[0].channel?.id === lastShownId) {
          const swapIdx = Math.floor(Math.random() * (reshuffled.length - 1)) + 1;
          [reshuffled[0], reshuffled[swapIdx]] = [reshuffled[swapIdx], reshuffled[0]];
        }
        this.heroItems = reshuffled;
        this.currentHeroIndex = 0;
      } else {
        this.currentHeroIndex = nextIndex;
      }

      // Prioritize background TMDB enrichment for the newly active hero
      const active = this.currentHero;
      if (active?.channel && this.tmdbConfig.isEnabled()) {
        this.tmdbEnrichment.enqueue(active.channel, 'high');
      }

      setTimeout(() => {
        this.isTransitioning = false;
      }, 50);
    }, 280);
  }

  prevHero() {
    if (this.heroItems.length > 0) {
      this.currentHeroIndex =
        (this.currentHeroIndex - 1 + this.heroItems.length) % this.heroItems.length;
    }
  }

  @HostListener('window:resize')
  onWindowResize(): void {
    this.checkAllRowsScrollState();
  }

  canScrollRight(rowId: string): boolean {
    if (this.rowCanScrollRight[rowId] !== undefined) {
      return this.rowCanScrollRight[rowId];
    }
    const el = document.getElementById(rowId);
    if (el && el.clientWidth > 0) {
      const maxScrollLeft = el.scrollWidth - el.clientWidth;
      const canScroll = maxScrollLeft - el.scrollLeft > 6;
      this.rowCanScrollRight[rowId] = canScroll;
      return canScroll;
    }
    return false;
  }

  onRowScroll(rowId: string): void {
    this.updateRowScrollState(rowId);
  }

  updateRowScrollState(rowId: string): void {
    const el = document.getElementById(rowId);
    if (!el) return;
    const maxScrollLeft = el.scrollWidth - el.clientWidth;
    const canScroll = maxScrollLeft - el.scrollLeft > 6;
    if (this.rowCanScrollRight[rowId] !== canScroll) {
      this.rowCanScrollRight[rowId] = canScroll;
      this.cdr.markForCheck();
    }
  }

  checkAllRowsScrollState(): void {
    for (const row of this.discoveryRows) {
      this.updateRowScrollState(row.id);
    }
  }

  scrollRow(rowId: string, direction: "left" | "right") {
    const el = document.getElementById(rowId);
    if (el) {
      const scrollAmount = Math.max(el.clientWidth * 0.75, 340);
      el.scrollBy({
        left: direction === "left" ? -scrollAmount : scrollAmount,
        behavior: "smooth",
      });
      setTimeout(() => this.updateRowScrollState(rowId), 450);
    }
  }

  async loadDiscovery(isManualRefresh: boolean = false) {
    this.loading = true;
    try {
      let sources = Array.from(this.memory.Sources.values());
      if (sources.length === 0) {
        try {
          const fetchedSources = (await invoke("get_sources")) as Source[];
          sources = fetchedSources.filter((s) => s.enabled);
        } catch {
          sources = [];
        }
      }

      const enabledSourceIds = sources.filter((s) => s.enabled).map((s) => s.id!);
      if (enabledSourceIds.length === 0) {
        this.loading = false;
        this.hasAnyContent = false;
        return;
      }

      // Check if sources changed; reset discovery state if source IDs changed
      this.discoveryState.checkSourceConsistency(enabledSourceIds);

      // Base filter strictly excluding LiveTV (Movies and Series only)
      const baseMediaTypes = [MediaType.movie, MediaType.serie];

      // 1. Fetch History, Favorites, Movies, Series, Categories concurrently
      const [historyRes, favoritesRes, moviesRes, seriesRes, categoriesRes] = await Promise.all([
        this.fetchSafe({
          source_ids: enabledSourceIds,
          view_type: ViewMode.History,
          media_types: baseMediaTypes,
          page: 1,
          sort: SortType.alphabeticalAscending,
          use_keywords: false,
        }),
        this.fetchSafe({
          source_ids: enabledSourceIds,
          view_type: ViewMode.Favorites,
          media_types: baseMediaTypes,
          page: 1,
          sort: SortType.alphabeticalAscending,
          use_keywords: false,
        }),
        this.fetchSafe({
          source_ids: enabledSourceIds,
          view_type: ViewMode.All,
          media_types: [MediaType.movie],
          page: 1,
          sort: SortType.provider,
          use_keywords: false,
        }),
        this.fetchSafe({
          source_ids: enabledSourceIds,
          view_type: ViewMode.All,
          media_types: [MediaType.serie],
          page: 1,
          sort: SortType.provider,
          use_keywords: false,
        }),
        this.fetchSafe({
          source_ids: enabledSourceIds,
          view_type: ViewMode.Categories,
          media_types: baseMediaTypes,
          page: 1,
          sort: SortType.alphabeticalAscending,
          use_keywords: false,
        }),
      ]);

      if (this.isDestroyed) return;

      // Populate groups map
      this.groupsMap.clear();
      for (const cat of categoriesRes) {
        if (cat.id && cat.name) {
          this.groupsMap.set(cat.id, cat.name);
        }
      }

      // Cache loaded series for fast resolution and episode show title lookup
      this.loadedSeries = seriesRes || [];
      this.seriesNameMap.clear();
      for (const s of this.loadedSeries) {
        const sId = s.url || (s.id ? String(s.id) : undefined);
        if (sId && s.name) {
          this.seriesNameMap.set(`${s.source_id}_${sId}`, s.name);
          if (s.id) {
            this.seriesNameMap.set(`${s.source_id}_${s.id}`, s.name);
          }
        }
      }

      // Deduplicate Continue Watching: one card per grouped movie/TV title, keeping most recent version
      const deduplicatedHistory = this.deduplicateContinueWatching(historyRes);
      const rows: DiscoveryRow[] = [];

      // 1. Continue Watching (always updated fresh from watch history)
      if (deduplicatedHistory.length > 0) {
        rows.push({
          id: "row-continue-watching",
          title: "Continue Watching",
          icon: "play-circle",
          badge: `${deduplicatedHistory.length}`,
          items: deduplicatedHistory,
        });

        for (const item of deduplicatedHistory) {
          if (this.isTvShow(item)) {
            this.resolveEpisodeStill(item);
          }
        }
      }

      // 2. Favorites (always updated fresh from favorites)
      if (favoritesRes.length > 0) {
        rows.push({
          id: "row-favorites",
          title: "Your Favorites",
          icon: "star",
          badge: `${favoritesRes.length}`,
          items: favoritesRes,
        });
      }

      // 3. Check for existing valid TMDB discovery state
      if (this.discoveryState.hasValidTmdbData()) {
        const snapshot = this.discoveryState.getSnapshot()!;
        this.allRecommended = snapshot.allRecommended;
        this.allLoadedMovies = snapshot.allLoadedMovies.length > 0 ? snapshot.allLoadedMovies : (moviesRes || []);
        this.allLoadedSeries = snapshot.allLoadedSeries.length > 0 ? snapshot.allLoadedSeries : (seriesRes || []);
        this.masterHeroItems = [...snapshot.masterHeroItems];
        this.heroItems = [...this.masterHeroItems];

        // Restore all TMDB rows (Recommended, Popular, Trending, Genre, Korean)
        for (const tmdbRow of snapshot.tmdbRows) {
          if (tmdbRow.id !== "row-continue-watching" && tmdbRow.id !== "row-favorites") {
            rows.push({ ...tmdbRow, items: [...tmdbRow.items] });
          }
        }

        this.masterDiscoveryRows = rows.sort(
          (a, b) => this.getRowPriority(a.id) - this.getRowPriority(b.id)
        );
        this.applyContentPreferences();
        this.hasAnyContent = this.heroItems.length > 0 || this.discoveryRows.length > 0;
        this.loading = false;

        // Background revalidation only if stale or forced refresh
        const shouldRevalidate = isManualRefresh || !this.discoveryState.isFresh();
        if (shouldRevalidate && this.tmdbConfig.isEnabled()) {
          setTimeout(() => {
            if (this.isDestroyed) return;
            this.triggerTmdbDiscoveryPipeline(
              enabledSourceIds,
              historyRes,
              favoritesRes,
              moviesRes,
              seriesRes,
              categoriesRes
            );
          }, 0);
        }

        this.enqueueVisibleCardsEnrichment();
        return;
      }

      // 4. Fallback State: only for initial cold start or when TMDB is disabled
      const recommendedList = this.computeRecommendations(
        historyRes,
        favoritesRes,
        moviesRes,
        seriesRes,
      );

      this.allLoadedMovies = moviesRes || [];
      this.allLoadedSeries = seriesRes || [];
      this.allRecommended = recommendedList || [];

      this.masterHeroItems = this.buildHeroPool(
        this.allLoadedMovies,
        this.allLoadedSeries,
        this.allRecommended,
      );
      this.heroItems = [...this.masterHeroItems];

      if (recommendedList.length >= 2) {
        rows.push({
          id: "row-recommended",
          title: "Recommended for You",
          icon: "sparkles",
          items: recommendedList,
        });
      }

      if (moviesRes.length >= 2) {
        rows.push({
          id: "row-popular-movies",
          title: "Popular Movies",
          icon: "film",
          items: moviesRes.slice(0, 24),
        });
      }

      if (seriesRes.length >= 2) {
        rows.push({
          id: "row-popular-series",
          title: "Popular TV Shows",
          icon: "tv",
          items: seriesRes.slice(0, 24),
        });
      }

      this.masterDiscoveryRows = rows.sort(
        (a, b) => this.getRowPriority(a.id) - this.getRowPriority(b.id)
      );
      this.applyContentPreferences();
      this.hasAnyContent = this.heroItems.length > 0 || this.discoveryRows.length > 0;
      this.loading = false;

      // 5. Asynchronously run TMDB discovery pipeline in background without blocking
      setTimeout(() => {
        if (this.isDestroyed) return;
        this.triggerTmdbDiscoveryPipeline(
          enabledSourceIds,
          historyRes,
          favoritesRes,
          moviesRes,
          seriesRes,
          categoriesRes
        );
      }, 0);

      // 6. Non-blocking progressive TMDB background enrichment if enabled
      this.enqueueVisibleCardsEnrichment();
    } catch (e) {
      console.error("Failed to load discovery:", e);
      this.loading = false;
    }
  }

  private triggerTmdbDiscoveryPipeline(
    sourceIds: number[],
    historyRes: Channel[],
    favoritesRes: Channel[],
    initialMovies: Channel[],
    initialSeries: Channel[],
    categoriesRes: Channel[]
  ): void {
    if (this.discoveryState.isPipelineRunning()) {
      return;
    }

    const runId = this.discoveryState.startNewRun();
    const pipelinePromise = (async () => {
      try {
        await this.loadTmdbHomeDiscoveryPipeline(
          sourceIds,
          historyRes,
          favoritesRes,
          initialMovies,
          initialSeries,
          categoriesRes,
          runId
        );
      } catch (err) {
        console.warn("TMDB discovery pipeline execution error:", err);
      } finally {
        this.discoveryState.setInFlightPipeline(null);
      }
    })();

    this.discoveryState.setInFlightPipeline(pipelinePromise);
  }

  private async fetchSafe(filters: Filters): Promise<Channel[]> {
    try {
      const res = (await invoke("search", { filters })) as Channel[];
      return res || [];
    } catch {
      return [];
    }
  }

  private computeRecommendations(
    history: Channel[],
    favorites: Channel[],
    movies: Channel[],
    series: Channel[],
  ): Channel[] {
    const affinityMap = new Map<number, number>();

    // 1. Collect affinity signals from Favorites and Watch History
    for (const fav of favorites) {
      if (fav.group_id) {
        affinityMap.set(fav.group_id, (affinityMap.get(fav.group_id) || 0) + 15);
      }
    }
    history.forEach((h, index) => {
      if (h.group_id) {
        const weight = index < 5 ? 12 : 6;
        affinityMap.set(h.group_id, (affinityMap.get(h.group_id) || 0) + weight);
      }
    });

    // 2. Media Type Preference (Movie vs Series)
    let seriesInteractions = 0;
    let movieInteractions = 0;
    for (const item of [...favorites, ...history]) {
      if (item.media_type === MediaType.serie) seriesInteractions++;
      else if (item.media_type === MediaType.movie) movieInteractions++;
    }

    const preferSeries = seriesInteractions > movieInteractions * 1.3;
    const preferMovies = movieInteractions > seriesInteractions * 1.3;

    // 3. Set of watched titles to avoid repeating items in Recommendations
    const watchedTitleSet = new Set(
      history.map((h) => cleanMediaTitle(h.name).toLowerCase()),
    );

    const candidatePool = [...movies, ...series].filter(
      (c) => c.media_type === MediaType.movie || c.media_type === MediaType.serie,
    );

    const scoredCandidates: { channel: Channel; score: number }[] = [];
    const seenTitles = new Set<string>();

    for (let i = 0; i < candidatePool.length; i++) {
      const c = candidatePool[i];
      const clean = cleanMediaTitle(c.name).toLowerCase();
      if (seenTitles.has(clean)) continue;
      seenTitles.add(clean);

      // Base score
      let score = 20;

      // Reward valid poster imagery
      if (c.image && c.image.startsWith("http")) {
        score += 30;
      }

      // Reward category affinity
      if (c.group_id && affinityMap.has(c.group_id)) {
        const affinity = affinityMap.get(c.group_id)!;
        score += Math.min(affinity * 2.5, 50);
      }

      // Media type preference alignment
      if (preferSeries && c.media_type === MediaType.serie) score += 12;
      if (preferMovies && c.media_type === MediaType.movie) score += 12;

      // Quality indicator bonus
      const quality = extractQuality(c.name);
      if (quality === "4K UHD") score += 8;
      else if (quality === "1080p") score += 4;

      // Popularity by catalog position (earlier in provider list)
      score += Math.max(0, 15 - Math.floor(i / 4));

      // Fresh discovery: penalize already watched titles so fresh recommendations appear
      if (watchedTitleSet.has(clean)) {
        score -= 35;
      }

      scoredCandidates.push({ channel: c, score });
    }

    // Cold start fallback if user has no history or favorites
    if (affinityMap.size === 0 && history.length === 0 && favorites.length === 0) {
      return this.curateColdStartRecommendations(movies, series);
    }

    scoredCandidates.sort((a, b) => b.score - a.score);
    const seenFranchises = new Set<string>();
    const diversified: Channel[] = [];
    for (const sc of scoredCandidates) {
      const fKey = this.getFranchiseKey(sc.channel.name);
      if (!seenFranchises.has(fKey)) {
        seenFranchises.add(fKey);
        diversified.push(sc.channel);
      }
      if (diversified.length >= 24) break;
    }
    return diversified;
  }

  private curateColdStartRecommendations(movies: Channel[], series: Channel[]): Channel[] {
    const curated: Channel[] = [];
    const seenTitles = new Set<string>();
    const seenFranchises = new Set<string>();

    const validMovies = movies.filter((m) => m.image && m.image.startsWith("http"));
    const validSeries = series.filter((s) => s.image && s.image.startsWith("http"));

    const maxLen = Math.max(validMovies.length, validSeries.length);
    for (let i = 0; i < maxLen; i++) {
      if (i < validMovies.length) {
        const m = validMovies[i];
        const title = cleanMediaTitle(m.name).toLowerCase();
        const franchise = this.getFranchiseKey(m.name);
        if (!seenTitles.has(title) && !seenFranchises.has(franchise)) {
          seenTitles.add(title);
          seenFranchises.add(franchise);
          curated.push(m);
        }
      }
      if (i < validSeries.length) {
        const s = validSeries[i];
        const title = cleanMediaTitle(s.name).toLowerCase();
        const franchise = this.getFranchiseKey(s.name);
        if (!seenTitles.has(title) && !seenFranchises.has(franchise)) {
          seenTitles.add(title);
          seenFranchises.add(franchise);
          curated.push(s);
        }
      }
      if (curated.length >= 24) break;
    }

    return curated;
  }

  private getRowPriority(rowId: string): number {
    if (rowId === "row-continue-watching") return 10;
    if (rowId === "row-recommended") return 20;
    if (rowId === "row-trending-movies") return 30;
    if (rowId === "row-trending-series") return 40;
    if (rowId === "row-popular-movies") return 50;
    if (rowId === "row-popular-series") return 60;
    if (rowId === "row-favorites") return 65;
    if (rowId === "row-korean-series") return 75;
    if (rowId.startsWith("row-genre-")) {
      const idx = parseInt(rowId.replace("row-genre-", ""), 10);
      return isNaN(idx) ? 100 : 100 + idx;
    }
    return 200;
  }

  setContentPreference(pref: ContentPreference): void {
    this.selectedContentPref = pref;
    try {
      localStorage.setItem("fred_tv_home_content_pref", pref);
    } catch {
      // ignore
    }
    this.applyContentPreferences();
  }

  private applyContentPreferences(): void {
    if (this.selectedContentPref === "all") {
      this.discoveryRows = this.masterDiscoveryRows.map((r) => ({
        ...r,
        items: [...r.items],
      }));
      this.heroItems = [...this.masterHeroItems];
      if (this.currentHeroIndex >= this.heroItems.length) {
        this.currentHeroIndex = 0;
      }
      this.rowCanScrollRight = {};
      setTimeout(() => this.checkAllRowsScrollState(), 50);
      return;
    }

    this.discoveryRows = this.masterDiscoveryRows
      .map((row) => {
        if (row.id === "row-continue-watching") {
          return { ...row, items: [...row.items] };
        }
        const filtered = row.items.filter((item) =>
          this.matchesContentPreference(item, this.selectedContentPref)
        );
        return {
          ...row,
          items: filtered,
        };
      })
      .filter((row) => row.items.length > 0);

    const prefMovies = this.allLoadedMovies.filter((m) =>
      this.matchesContentPreference(m, this.selectedContentPref)
    );
    const prefSeries = this.allLoadedSeries.filter((s) =>
      this.matchesContentPreference(s, this.selectedContentPref)
    );
    const prefRec = this.allRecommended.filter((r) =>
      this.matchesContentPreference(r, this.selectedContentPref)
    );

    const prefHeroPool = this.buildHeroPool(prefMovies, prefSeries, prefRec);
    this.heroItems = prefHeroPool.length > 0 ? prefHeroPool : [...this.masterHeroItems];
    if (this.currentHeroIndex >= this.heroItems.length) {
      this.currentHeroIndex = 0;
    }
    this.rowCanScrollRight = {};
    setTimeout(() => this.checkAllRowsScrollState(), 50);
  }

  matchesContentPreference(channel: Channel, pref: ContentPreference): boolean {
    if (pref === "all") return true;

    const rawName = channel.name || "";
    const groupName =
      (channel.group_id ? this.groupsMap.get(channel.group_id) : "") || "";
    const combined = `${groupName} ${rawName}`.toLowerCase();

    const cached = this.tmdbEnrichment.getEnrichmentSync(channel);
    const origLang = (cached?.originalLanguage || "").toLowerCase();

    if (pref === "english") {
      const hasNonEnglishTag =
        /\b(?:hindi|bollywood|punjabi|tamil|telugu|malayalam|kannada|korean|k-drama|kdrama|spanish|espanol|french|francais|german|deutsch|italian|italiano|arabic|turkish|chinese|japanese|anime)\b/i.test(
          combined
        ) ||
        /(?:\[|\||\()(?:hi|hin|ind|kr|kor|es|esp|fr|fra|de|ger|it|ita|ar|ara|tr|tur|cn|zh|jp|jpn)(?:\]|\||\))/i.test(
          rawName
        );

      if (hasNonEnglishTag) {
        return false;
      }
      if (origLang) {
        return origLang === "en";
      }
      return true;
    }

    if (pref === "hindi") {
      if (
        origLang &&
        ["hi", "te", "ta", "ml", "kn", "pa", "bn", "mr", "gu"].includes(origLang)
      ) {
        return true;
      }
      return (
        /\b(?:hindi|bollywood|punjabi|tamil|telugu|malayalam|kannada|indian|india|bengali|marathi|gujarati|tollywood|kollywood)\b/i.test(
          combined
        ) ||
        /(?:\[|\||\()(?:hi|hin|ind|bolly|pun|tam|tel|mal|kan)(?:\]|\||\))/i.test(
          rawName
        )
      );
    }

    if (pref === "korean") {
      if (
        origLang === "ko" ||
        (cached?.originCountry &&
          cached.originCountry.some((c) => c.toUpperCase() === "KR"))
      ) {
        return true;
      }
      return (
        /\b(?:korean|k-drama|kdrama|korea)\b/i.test(combined) ||
        /(?:\[|\||\()(?:kr|kor|kdrama)(?:\]|\||\))/i.test(rawName)
      );
    }

    return true;
  }

  private getSessionSeed(): number {
    let seedStr = sessionStorage.getItem("lighthouse_discovery_seed");
    if (!seedStr) {
      const seedVal = Math.floor(Math.random() * 1000000) + 1;
      seedStr = String(seedVal);
      try {
        sessionStorage.setItem("lighthouse_discovery_seed", seedStr);
      } catch {
        // ignore
      }
    }
    return parseInt(seedStr, 10) || 12345;
  }

  private getLastFeaturedIds(): Set<number> {
    try {
      const stored = localStorage.getItem("lighthouse_last_featured_ids");
      if (stored) {
        const arr = JSON.parse(stored);
        if (Array.isArray(arr)) {
          return new Set<number>(arr);
        }
      }
    } catch {
      // ignore
    }
    return new Set<number>();
  }

  private saveCurrentFeaturedIds(ids: number[]): void {
    try {
      localStorage.setItem("lighthouse_last_featured_ids", JSON.stringify(ids.slice(0, 50)));
    } catch {
      // ignore
    }
  }

  private getFranchiseKey(title?: string): string {
    const clean = cleanMediaTitle(title || "").toLowerCase();
    const franchises = [
      "spider-man", "spiderman", "batman", "superman", "star wars", "star trek",
      "fast & furious", "fast and furious", "harry potter", "fantastic beasts",
      "lord of the rings", "hobbit", "marvel", "avengers", "iron man", "thor",
      "captain america", "guardians of the galaxy", "deadpool", "x-men", "wolverine",
      "jurassic park", "jurassic world", "mission impossible", "mission: impossible",
      "transformers", "matrix", "john wick", "indiana jones", "toy story",
      "shrek", "despicable me", "minions", "kung fu panda", "ice age",
      "pirates of the caribbean", "hunger games", "twilight", "divergent",
      "planet of the apes", "alien", "predator", "terminator", "die hard",
      "lethal weapon", "bad boys", "james bond", "007", "rocky", "creed"
    ];
    for (const f of franchises) {
      if (clean.includes(f)) return f;
    }
    const words = clean.replace(/[^a-z0-9\s]/g, "").trim().split(/\s+/).filter((w) => w.length > 2);
    if (words.length >= 2) {
      return `${words[0]} ${words[1]}`;
    }
    return words[0] || clean;
  }

  private async loadTmdbHomeDiscoveryPipeline(
    sourceIds: number[],
    historyRes: Channel[],
    favoritesRes: Channel[],
    initialMovies: Channel[],
    initialSeries: Channel[],
    categoriesRes: Channel[],
    runId?: number
  ): Promise<void> {
    if (runId !== undefined && runId !== this.discoveryState.getCurrentRunId()) {
      return;
    }

    if (!this.tmdbConfig.isEnabled()) {
      await Promise.allSettled([
        this.loadTrendingMoviesRow(sourceIds, initialMovies),
        this.loadTrendingTvRow(sourceIds, initialSeries),
        this.loadCuratedMixedGenreRows(sourceIds, categoriesRes, initialMovies, initialSeries),
        this.loadKoreanContentRows(sourceIds),
      ]);
      return;
    }

    try {
      // 1. Expand in-memory catalog pool by fetching page 2 of movies & series in background
      // This enables fast in-memory matching and minimizes repeated SQLite searches
      const [page2Movies, page2Series] = await Promise.all([
        this.fetchSafe({
          source_ids: sourceIds,
          view_type: ViewMode.All,
          media_types: [MediaType.movie],
          page: 2,
          sort: SortType.provider,
          use_keywords: false,
        }),
        this.fetchSafe({
          source_ids: sourceIds,
          view_type: ViewMode.All,
          media_types: [MediaType.serie],
          page: 2,
          sort: SortType.provider,
          use_keywords: false,
        }),
      ]);

      if (runId !== undefined && runId !== this.discoveryState.getCurrentRunId()) {
        return;
      }

      const moviesPool = [...initialMovies, ...(page2Movies || [])];
      const seriesPool = [...initialSeries, ...(page2Series || [])];
      this.allLoadedMovies = moviesPool;
      this.allLoadedSeries = seriesPool;

      // 2. Concurrently execute TMDB discovery pipelines
      await Promise.allSettled([
        this.loadTmdbRecommendedRow(sourceIds, historyRes, favoritesRes, moviesPool, seriesPool),
        this.loadTmdbPopularMoviesRow(sourceIds, moviesPool),
        this.loadTmdbPopularTvRow(sourceIds, seriesPool),
        this.loadTrendingMoviesRow(sourceIds, moviesPool),
        this.loadTrendingTvRow(sourceIds, seriesPool),
        this.loadCuratedMixedGenreRows(sourceIds, categoriesRes, moviesPool, seriesPool),
        this.loadKoreanContentRows(sourceIds),
      ]);

      if (runId !== undefined && runId !== this.discoveryState.getCurrentRunId()) {
        return;
      }

      // 3. Assemble dynamic hero banner pool from highest quality TMDB candidates
      this.refreshHeroPoolFromTmdbDiscovery();

      // 4. Save completed snapshot to HomeDiscoveryStateService so it survives navigation
      const tmdbRows = this.masterDiscoveryRows.filter(
        (r) => r.id !== "row-continue-watching" && r.id !== "row-favorites"
      );
      this.discoveryState.markPipelineSuccess(
        tmdbRows,
        this.masterHeroItems,
        this.allRecommended,
        this.allLoadedMovies,
        this.allLoadedSeries
      );
    } catch (err) {
      console.warn("Error in TMDB discovery pipeline:", err);
    }
  }

  private async loadTmdbRecommendedRow(
    sourceIds: number[],
    history: Channel[],
    favorites: Channel[],
    moviesPool: Channel[],
    seriesPool: Channel[]
  ): Promise<void> {
    try {
      // 1. Gather seeds from watch history and favorites
      const seeds: { tmdbId: number; isTv: boolean }[] = [];
      const userGenreSet = new Set<string>();

      // Check history (most recently watched first)
      for (const h of history.slice(0, 8)) {
        const isTv = this.isTvShow(h);
        const cached = this.tmdbEnrichment.getEnrichmentSync(h);
        if (cached?.tmdbId && !seeds.some((s) => s.tmdbId === cached.tmdbId)) {
          seeds.push({ tmdbId: cached.tmdbId, isTv });
        }
        if (cached?.genres) {
          for (const g of cached.genres) userGenreSet.add(g.toLowerCase());
        }
      }

      // Check favorites
      for (const f of favorites.slice(0, 6)) {
        const isTv = this.isTvShow(f);
        const cached = this.tmdbEnrichment.getEnrichmentSync(f);
        if (cached?.tmdbId && !seeds.some((s) => s.tmdbId === cached.tmdbId)) {
          seeds.push({ tmdbId: cached.tmdbId, isTv });
        }
        if (cached?.genres) {
          for (const g of cached.genres) userGenreSet.add(g.toLowerCase());
        }
      }

      // 2. Harvest candidate pool from TMDB
      const candidateMap = new Map<number, { item: any; isTv: boolean; fromSeed: boolean }>();

      // A. Seed-based recommendations & similar titles
      if (seeds.length > 0) {
        const seedRecommendations = await this.tmdbEnrichment.getRecommendationsForSeeds(seeds);
        for (const item of seedRecommendations) {
          if (item?.id && !candidateMap.has(item.id)) {
            const isTv = item.media_type === "tv" || !!item.first_air_date;
            candidateMap.set(item.id, { item, isTv, fromSeed: true });
          }
        }
      }

      // B. Top Rated & Trending candidates for breadth & cold-start discovery
      const [topRatedMovies, topRatedTv, trendingMovies] = await Promise.allSettled([
        this.tmdbEnrichment.getTopRatedMovies(1),
        this.tmdbEnrichment.getTopRatedTv(1),
        this.tmdbEnrichment.getTrendingMovies("week"),
      ]);

      if (topRatedMovies.status === "fulfilled" && Array.isArray(topRatedMovies.value)) {
        for (const item of topRatedMovies.value) {
          if (item?.id && !candidateMap.has(item.id)) {
            candidateMap.set(item.id, { item, isTv: false, fromSeed: false });
          }
        }
      }
      if (topRatedTv.status === "fulfilled" && Array.isArray(topRatedTv.value)) {
        for (const item of topRatedTv.value) {
          if (item?.id && !candidateMap.has(item.id)) {
            candidateMap.set(item.id, { item, isTv: true, fromSeed: false });
          }
        }
      }
      if (trendingMovies.status === "fulfilled" && Array.isArray(trendingMovies.value)) {
        for (const item of trendingMovies.value) {
          if (item?.id && !candidateMap.has(item.id)) {
            candidateMap.set(item.id, { item, isTv: false, fromSeed: false });
          }
        }
      }

      if (candidateMap.size === 0) return;

      // 3. Score candidates
      const watchedTitles = new Set(
        history.map((h) => cleanMediaTitle(h.name).toLowerCase())
      );
      const lastFeaturedIds = this.getLastFeaturedIds();

      interface ScoredCandidate {
        item: any;
        isTv: boolean;
        score: number;
      }

      const scoredList: ScoredCandidate[] = [];

      for (const entry of candidateMap.values()) {
        const item = entry.item;
        const title = (item.title || item.name || "").toLowerCase();

        // Fresh discovery: exclude already watched titles
        if (watchedTitles.has(title)) {
          continue;
        }

        let score = 20;

        // Reward high TMDB rating
        if (item.vote_average) {
          score += item.vote_average * 5;
        }

        // Reward vote count reliability
        if (item.vote_count) {
          score += Math.min(25, Math.log10(Math.max(1, item.vote_count)) * 7);
        }

        // Direct seed recommendation bonus
        if (entry.fromSeed) {
          score += 35;
        }

        // Genre affinity bonus
        if (item.genre_ids && Array.isArray(item.genre_ids) && userGenreSet.size > 0) {
          score += 15;
        }

        // Recency bonus
        const dateStr = item.release_date || item.first_air_date;
        if (dateStr && dateStr.length >= 4) {
          const year = parseInt(dateStr.substring(0, 4), 10);
          if (!isNaN(year) && year >= 2021) {
            score += 10;
          }
        }

        // Popularity signal
        if (item.popularity) {
          score += Math.min(20, Math.log10(Math.max(1, item.popularity)) * 6);
        }

        // Cross-session freshness adjustment: slight penalty if featured in previous session
        if (lastFeaturedIds.has(item.id)) {
          score -= 15;
        }

        scoredList.push({
          item,
          isTv: entry.isTv,
          score,
        });
      }

      scoredList.sort((a, b) => b.score - a.score);

      // 4. Match against IPTV catalog with franchise diversity
      const matchedChannels: Channel[] = [];
      const seenFranchises = new Set<string>();
      const seenNorms = new Set<string>();

      for (const cand of scoredList) {
        if (matchedChannels.length >= 24) break;

        const pool = cand.isTv ? seriesPool : moviesPool;
        const matched = await this.matchTmdbItemToCatalog(
          cand.item,
          cand.isTv,
          pool,
          sourceIds
        );

        if (matched && matched.id) {
          const norm = this.versionMatching.normalizeNumberTokens(
            normalizeForComparison(cleanMediaTitle(matched.name))
          );
          if (seenNorms.has(norm)) continue;

          const franchise = this.getFranchiseKey(matched.name);
          if (seenFranchises.has(franchise)) continue;

          seenNorms.add(norm);
          seenFranchises.add(franchise);
          matchedChannels.push(matched);
        }
      }

      if (matchedChannels.length >= 4) {
        this.allRecommended = matchedChannels;
        this.upsertDiscoveryRow({
          id: "row-recommended",
          title: "Recommended for You",
          icon: "sparkles",
          items: matchedChannels,
        });
      }
    } catch (err) {
      console.warn("Failed to load TMDB recommendations row:", err);
    }
  }

  private async loadTmdbPopularMoviesRow(
    sourceIds: number[],
    moviesPool: Channel[]
  ): Promise<void> {
    try {
      const [page1, page2] = await Promise.allSettled([
        this.tmdbEnrichment.getPopularMovies(1),
        this.tmdbEnrichment.getPopularMovies(2),
      ]);

      const candidates: any[] = [];
      if (page1.status === "fulfilled" && Array.isArray(page1.value)) {
        candidates.push(...page1.value);
      }
      if (page2.status === "fulfilled" && Array.isArray(page2.value)) {
        candidates.push(...page2.value);
      }

      if (candidates.length === 0) return;

      // Ranked strictly by TMDB popularity descending
      candidates.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));

      const recommendedIds = new Set(this.allRecommended.map((r) => r.id));
      const matchedMovies: Channel[] = [];
      const seenFranchises = new Set<string>();
      const seenNorms = new Set<string>();

      for (const item of candidates) {
        if (matchedMovies.length >= 32) break;

        const matched = await this.matchTmdbItemToCatalog(
          item,
          false,
          moviesPool,
          sourceIds
        );

        if (matched && matched.id) {
          const norm = this.versionMatching.normalizeNumberTokens(
            normalizeForComparison(cleanMediaTitle(matched.name))
          );
          if (seenNorms.has(norm)) continue;

          const franchise = this.getFranchiseKey(matched.name);
          if (seenFranchises.has(franchise)) continue;

          // Avoid duplicate items with Recommended for You unless pool is small
          if (recommendedIds.has(matched.id) && matchedMovies.length >= 12) {
            continue;
          }

          seenNorms.add(norm);
          seenFranchises.add(franchise);
          matchedMovies.push(matched);
        }
      }

      if (matchedMovies.length >= 4) {
        // Session-to-session deterministic rotation offset
        const seed = this.getSessionSeed();
        const maxOffset = Math.min(6, Math.max(0, matchedMovies.length - 20));
        const offset = maxOffset > 0 ? seed % maxOffset : 0;
        const rotated = [
          ...matchedMovies.slice(offset),
          ...matchedMovies.slice(0, offset),
        ].slice(0, 24);

        this.upsertDiscoveryRow({
          id: "row-popular-movies",
          title: "Popular Movies",
          icon: "film",
          items: rotated,
        });
      }
    } catch (err) {
      console.warn("Failed to load TMDB popular movies row:", err);
    }
  }

  private async loadTmdbPopularTvRow(
    sourceIds: number[],
    seriesPool: Channel[]
  ): Promise<void> {
    try {
      const [page1, page2] = await Promise.allSettled([
        this.tmdbEnrichment.getPopularTv(1),
        this.tmdbEnrichment.getPopularTv(2),
      ]);

      const candidates: any[] = [];
      if (page1.status === "fulfilled" && Array.isArray(page1.value)) {
        candidates.push(...page1.value);
      }
      if (page2.status === "fulfilled" && Array.isArray(page2.value)) {
        candidates.push(...page2.value);
      }

      if (candidates.length === 0) return;

      candidates.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));

      const recommendedIds = new Set(this.allRecommended.map((r) => r.id));
      const matchedSeries: Channel[] = [];
      const seenFranchises = new Set<string>();
      const seenNorms = new Set<string>();

      for (const item of candidates) {
        if (matchedSeries.length >= 32) break;

        const matched = await this.matchTmdbItemToCatalog(
          item,
          true,
          seriesPool,
          sourceIds
        );

        if (matched && matched.id) {
          const norm = this.versionMatching.normalizeNumberTokens(
            normalizeForComparison(cleanMediaTitle(matched.name))
          );
          if (seenNorms.has(norm)) continue;

          const franchise = this.getFranchiseKey(matched.name);
          if (seenFranchises.has(franchise)) continue;

          if (recommendedIds.has(matched.id) && matchedSeries.length >= 12) {
            continue;
          }

          seenNorms.add(norm);
          seenFranchises.add(franchise);
          matchedSeries.push(matched);
        }
      }

      if (matchedSeries.length >= 4) {
        const seed = this.getSessionSeed();
        const maxOffset = Math.min(6, Math.max(0, matchedSeries.length - 20));
        const offset = maxOffset > 0 ? seed % maxOffset : 0;
        const rotated = [
          ...matchedSeries.slice(offset),
          ...matchedSeries.slice(0, offset),
        ].slice(0, 24);

        this.upsertDiscoveryRow({
          id: "row-popular-series",
          title: "Popular TV Shows",
          icon: "tv",
          items: rotated,
        });
      }
    } catch (err) {
      console.warn("Failed to load TMDB popular series row:", err);
    }
  }

  private refreshHeroPoolFromTmdbDiscovery(): void {
    const trendingMoviesRow = this.masterDiscoveryRows.find((r) => r.id === "row-trending-movies");
    const trendingTvRow = this.masterDiscoveryRows.find((r) => r.id === "row-trending-series");
    const popularMoviesRow = this.masterDiscoveryRows.find((r) => r.id === "row-popular-movies");
    const popularTvRow = this.masterDiscoveryRows.find((r) => r.id === "row-popular-series");
    const recommendedRow = this.masterDiscoveryRows.find((r) => r.id === "row-recommended");

    const heroCandidateMovies: Channel[] = [
      ...(trendingMoviesRow?.items || []).slice(0, 8),
      ...(popularMoviesRow?.items || []).slice(0, 8),
      ...(recommendedRow?.items || []).filter((i) => !this.isTvShow(i)).slice(0, 6),
      ...this.allLoadedMovies.slice(0, 10),
    ];

    const heroCandidateSeries: Channel[] = [
      ...(trendingTvRow?.items || []).slice(0, 8),
      ...(popularTvRow?.items || []).slice(0, 8),
      ...(recommendedRow?.items || []).filter((i) => this.isTvShow(i)).slice(0, 6),
      ...this.allLoadedSeries.slice(0, 10),
    ];

    const newHeroPool = this.buildHeroPool(
      heroCandidateMovies,
      heroCandidateSeries,
      this.allRecommended
    );

    if (newHeroPool.length > 0) {
      this.masterHeroItems = newHeroPool;
      this.heroItems = [...this.masterHeroItems];
      this.discoveryState.setHeroPool(newHeroPool);
      this.discoveryState.setLoadedPools(
        this.allLoadedMovies,
        this.allLoadedSeries,
        this.allRecommended
      );

      // Session seed rotation for initial hero index
      const seed = this.getSessionSeed();
      this.currentHeroIndex = seed % Math.min(this.heroItems.length, 6);

      // Save current top featured IDs to track cross-session exposure
      const featuredIds: number[] = [];
      const currentHeroId = this.heroItems[this.currentHeroIndex]?.channel?.id;
      if (currentHeroId) featuredIds.push(currentHeroId);
      for (const item of (recommendedRow?.items || []).slice(0, 8)) {
        if (item.id) featuredIds.push(item.id);
      }
      for (const item of (popularMoviesRow?.items || []).slice(0, 6)) {
        if (item.id) featuredIds.push(item.id);
      }
      this.saveCurrentFeaturedIds(featuredIds);

      if (!this.isDestroyed) {
        this.applyContentPreferences();
        this.cdr.markForCheck();
      }
    }
  }

  private async loadTrendingMoviesRow(
    sourceIds: number[],
    moviesPool: Channel[]
  ): Promise<void> {
    try {
      const trending = await this.tmdbEnrichment.getTrendingMovies("week");
      if (!trending || trending.length === 0) return;

      const matchedChannels: Channel[] = [];
      const seenNorms = new Set<string>();
      const seenFranchises = new Set<string>();

      for (const item of trending) {
        if (matchedChannels.length >= 24) break;
        const matched = await this.matchTmdbItemToCatalog(
          item,
          false,
          moviesPool,
          sourceIds
        );
        if (matched && matched.id) {
          const norm = this.versionMatching.normalizeNumberTokens(
            normalizeForComparison(cleanMediaTitle(matched.name))
          );
          const franchise = this.getFranchiseKey(matched.name);
          if (!seenNorms.has(norm) && !seenFranchises.has(franchise)) {
            seenNorms.add(norm);
            seenFranchises.add(franchise);
            matchedChannels.push(matched);
          }
        }
      }

      if (matchedChannels.length >= 4) {
        this.upsertDiscoveryRow({
          id: "row-trending-movies",
          title: "Top Trending Movies",
          icon: "film",
          items: matchedChannels,
        });
      }
    } catch (err) {
      console.warn("Failed to load trending movies row:", err);
    }
  }

  private async loadTrendingTvRow(
    sourceIds: number[],
    seriesPool: Channel[]
  ): Promise<void> {
    try {
      const trending = await this.tmdbEnrichment.getTrendingTv("week");
      if (!trending || trending.length === 0) return;

      const matchedChannels: Channel[] = [];
      const seenNorms = new Set<string>();
      const seenFranchises = new Set<string>();

      for (const item of trending) {
        if (matchedChannels.length >= 24) break;
        const matched = await this.matchTmdbItemToCatalog(
          item,
          true,
          seriesPool,
          sourceIds
        );
        if (matched && matched.id) {
          const norm = this.versionMatching.normalizeNumberTokens(
            normalizeForComparison(cleanMediaTitle(matched.name))
          );
          const franchise = this.getFranchiseKey(matched.name);
          if (!seenNorms.has(norm) && !seenFranchises.has(franchise)) {
            seenNorms.add(norm);
            seenFranchises.add(franchise);
            matchedChannels.push(matched);
          }
        }
      }

      if (matchedChannels.length >= 4) {
        this.upsertDiscoveryRow({
          id: "row-trending-series",
          title: "Top Trending TV Shows",
          icon: "tv",
          items: matchedChannels,
        });
      }
    } catch (err) {
      console.warn("Failed to load trending series row:", err);
    }
  }

  private async matchTmdbItemToCatalog(
    item: any,
    isTv: boolean,
    inMemoryPool: Channel[],
    sourceIds: number[]
  ): Promise<Channel | null> {
    if (!item) return null;

    // 0. Fast in-memory cache lookup in HomeDiscoveryStateService
    if (item.id) {
      const stateMatch = this.discoveryState.getCachedCatalogMatch(item.id, isTv);
      if (stateMatch) {
        return stateMatch;
      }
    }

    // 1. Check hot memory cache by TMDB ID
    if (item.id) {
      const cached = this.tmdbCache.getEnrichmentByTmdbIdSync(item.id);
      if (cached?.providerItemId) {
        const poolMatch = inMemoryPool.find((c) => c.id === cached.providerItemId);
        if (poolMatch) {
          this.discoveryState.setCachedCatalogMatch(item.id, isTv, poolMatch);
          return poolMatch;
        }
      }
    }

    const candidateTitles: string[] = [];
    if (isTv) {
      if (item.name) candidateTitles.push(item.name);
      if (item.original_name && item.original_name !== item.name) {
        candidateTitles.push(item.original_name);
      }
    } else {
      if (item.title) candidateTitles.push(item.title);
      if (item.original_title && item.original_title !== item.title) {
        candidateTitles.push(item.original_title);
      }
    }

    if (candidateTitles.length === 0) return null;

    const dateStr = item.release_date || item.first_air_date;
    const targetYear =
      dateStr && dateStr.length >= 4
        ? parseInt(dateStr.substring(0, 4), 10)
        : undefined;

    for (const rawTitle of candidateTitles) {
      const clean = cleanMediaTitle(rawTitle);
      const norm = this.versionMatching.normalizeNumberTokens(
        normalizeForComparison(clean)
      );

      // 2. Try matching from in-memory pool first
      const poolMatch = this.findBestCatalogMatch(
        norm,
        clean,
        targetYear,
        inMemoryPool,
        isTv
      );
      if (poolMatch) {
        this.tmdbEnrichment.seedEnrichmentFromTmdbItem(poolMatch, item);
        if (item.id) {
          this.discoveryState.setCachedCatalogMatch(item.id, isTv, poolMatch);
        }
        return poolMatch;
      }

      // 3. Query SQLite via fetchSafe
      try {
        const searchResults = await this.fetchSafe({
          source_ids: sourceIds,
          view_type: ViewMode.All,
          media_types: isTv ? [MediaType.serie] : [MediaType.movie],
          query: clean,
          page: 1,
          sort: SortType.alphabeticalAscending,
          use_keywords: false,
        });

        if (searchResults && searchResults.length > 0) {
          const dbMatch = this.findBestCatalogMatch(
            norm,
            clean,
            targetYear,
            searchResults,
            isTv
          );
          if (dbMatch) {
            this.tmdbEnrichment.seedEnrichmentFromTmdbItem(dbMatch, item);
            if (item.id) {
              this.discoveryState.setCachedCatalogMatch(item.id, isTv, dbMatch);
            }
            return dbMatch;
          }
        }
      } catch {
        // ignore
      }
    }

    return null;
  }

  private async matchTrendingItemToCatalog(
    item: any,
    isTv: boolean,
    inMemoryPool: Channel[],
    sourceIds: number[]
  ): Promise<Channel | null> {
    return this.matchTmdbItemToCatalog(item, isTv, inMemoryPool, sourceIds);
  }

  private findBestCatalogMatch(
    targetNorm: string,
    targetClean: string,
    targetYear: number | undefined,
    candidates: Channel[],
    isTv: boolean
  ): Channel | null {
    let bestCandidate: Channel | null = null;
    let bestScore = 0;

    for (const cand of candidates) {
      if (this.isTvShow(cand) !== isTv) continue;

      const candClean = cleanMediaTitle(cand.name);
      const candNorm = this.versionMatching.normalizeNumberTokens(
        normalizeForComparison(candClean)
      );

      let titleScore = 0;
      if (
        candNorm === targetNorm ||
        candClean.toLowerCase() === targetClean.toLowerCase()
      ) {
        titleScore = 1.0;
      } else {
        const dice = calculateDiceSimilarity(candNorm, targetNorm);
        const token = calculateTokenSimilarity(candNorm, targetNorm);
        const sim = Math.max(dice, token);
        if (sim >= 0.85) {
          titleScore = sim;
        }
      }

      if (titleScore < 0.85) continue;

      const candYearStr = extractYear(cand.name);
      if (targetYear && candYearStr) {
        const candYear = parseInt(candYearStr, 10);
        if (!isNaN(candYear) && Math.abs(candYear - targetYear) > 1) {
          continue;
        }
      }

      if (titleScore > bestScore) {
        bestScore = titleScore;
        bestCandidate = cand;
        if (bestScore === 1.0) break;
      }
    }

    return bestCandidate;
  }

  private async loadCuratedMixedGenreRows(
    sourceIds: number[],
    categoriesRes: Channel[],
    moviesPool: Channel[],
    seriesPool: Channel[]
  ): Promise<void> {
    const genreRows: DiscoveryRow[] = [];
    const basePool = [...moviesPool, ...seriesPool];

    for (let idx = 0; idx < MIXED_GENRES.length; idx++) {
      if (genreRows.length >= 8) break; // Maximum 5-8 genre rows
      const def = MIXED_GENRES[idx];

      // 1. Find provider categories matching this mixed genre
      const matchedCategoryIds = categoriesRes
        .filter((cat) => {
          if (!cat.id || !cat.name) return false;
          const lower = cat.name.toLowerCase();
          if (lower.includes("xxx") || lower.includes("adult")) return false;
          const cleaned = cleanCategoryTitle(cat.name) || "";
          return def.patterns.some((p) => p.test(cat.name!) || p.test(cleaned));
        })
        .map((cat) => cat.id!)
        .slice(0, 3);

      // 2. Query items from those categories
      let fetchedFromCats: Channel[] = [];
      if (matchedCategoryIds.length > 0) {
        const catPromises = matchedCategoryIds.map((gid) =>
          this.fetchSafe({
            source_ids: sourceIds,
            view_type: ViewMode.All,
            group_id: gid,
            media_types: [MediaType.movie, MediaType.serie],
            page: 1,
            sort: SortType.provider,
            use_keywords: false,
          })
        );
        const resList = await Promise.allSettled(catPromises);
        for (const res of resList) {
          if (res.status === "fulfilled" && res.value) {
            fetchedFromCats.push(...res.value);
          }
        }
      }

      // 3. Also check basePool items for category ID or cached TMDB genres
      const matchedFromPool: Channel[] = [];
      for (const item of basePool) {
        if (item.group_id && matchedCategoryIds.includes(item.group_id)) {
          matchedFromPool.push(item);
          continue;
        }
        const cached = this.tmdbEnrichment.getEnrichmentSync(item);
        if (cached?.genres && cached.genres.length > 0) {
          const hasTmdbMatch = cached.genres.some((g) =>
            def.tmdbGenres.some((tg) => g.toLowerCase().includes(tg))
          );
          if (hasTmdbMatch) {
            matchedFromPool.push(item);
          }
        }
      }

      // 4. Combine and deduplicate provider versions
      const allCandidates = [...fetchedFromCats, ...matchedFromPool];
      const uniqueItems: Channel[] = [];
      const seenTitles = new Set<string>();

      for (const cand of allCandidates) {
        const clean = cleanMediaTitle(cand.name);
        const norm = this.versionMatching.normalizeNumberTokens(
          normalizeForComparison(clean)
        );
        if (!seenTitles.has(norm)) {
          seenTitles.add(norm);
          uniqueItems.push(cand);
        }
        if (uniqueItems.length >= 24) break;
      }

      // 5. "Only show a row with at least 8 useful titles. Skip sparse/empty genres."
      if (uniqueItems.length >= 8) {
        genreRows.push({
          id: `row-genre-${idx}`,
          title: def.title,
          icon: def.icon,
          items: uniqueItems,
        });
      }
    }

    if (genreRows.length > 0) {
      this.discoveryState.setGenreRows(genreRows);
      this.masterDiscoveryRows = this.masterDiscoveryRows.filter(
        (r) => !r.id.startsWith("row-genre-")
      );
      this.masterDiscoveryRows.push(...genreRows);
      this.masterDiscoveryRows.sort(
        (a, b) => this.getRowPriority(a.id) - this.getRowPriority(b.id)
      );
      if (!this.isDestroyed) {
        this.applyContentPreferences();
        this.cdr.markForCheck();
      }
    }
  }

  private upsertDiscoveryRow(newRow: DiscoveryRow): void {
    this.discoveryState.upsertTmdbRow(newRow);
    const existingIdx = this.masterDiscoveryRows.findIndex(
      (r) => r.id === newRow.id
    );
    if (existingIdx !== -1) {
      this.masterDiscoveryRows[existingIdx] = newRow;
    } else {
      this.masterDiscoveryRows.push(newRow);
    }
    this.masterDiscoveryRows.sort(
      (a, b) => this.getRowPriority(a.id) - this.getRowPriority(b.id)
    );
    if (!this.isDestroyed) {
      this.applyContentPreferences();
      this.cdr.markForCheck();
    }
  }

  private syncFromSnapshot(snapshot: HomeDiscoverySnapshot): void {
    if (this.isDestroyed || !snapshot) return;

    this.allRecommended = snapshot.allRecommended;
    this.allLoadedMovies =
      snapshot.allLoadedMovies.length > 0 ? snapshot.allLoadedMovies : this.allLoadedMovies;
    this.allLoadedSeries =
      snapshot.allLoadedSeries.length > 0 ? snapshot.allLoadedSeries : this.allLoadedSeries;
    this.masterHeroItems = [...snapshot.masterHeroItems];
    this.heroItems = [...this.masterHeroItems];

    // Preserve fresh local rows: Continue Watching & Favorites
    const cwRow = this.masterDiscoveryRows.find((r) => r.id === "row-continue-watching");
    const favRow = this.masterDiscoveryRows.find((r) => r.id === "row-favorites");

    const mergedRows: DiscoveryRow[] = [];
    if (cwRow) mergedRows.push(cwRow);
    if (favRow) mergedRows.push(favRow);

    for (const tmdbRow of snapshot.tmdbRows) {
      if (tmdbRow.id !== "row-continue-watching" && tmdbRow.id !== "row-favorites") {
        mergedRows.push({ ...tmdbRow, items: [...tmdbRow.items] });
      }
    }

    this.masterDiscoveryRows = mergedRows.sort(
      (a, b) => this.getRowPriority(a.id) - this.getRowPriority(b.id)
    );
    this.applyContentPreferences();
    this.hasAnyContent = this.heroItems.length > 0 || this.discoveryRows.length > 0;
    this.cdr.markForCheck();
  }

  private async loadKoreanContentRows(sourceIds: number[]): Promise<void> {
    await this.loadKoreanSeriesRow(sourceIds);
  }

  private async loadKoreanSeriesRow(sourceIds: number[]): Promise<void> {
    try {
      const categoryIds = await this.findKoreanCategoryIds(
        sourceIds,
        MediaType.serie,
        [
          "ASIA SERIES (MULTI-SUBS)",
          "ASIA SERIES",
          "VIAPLAY SERIES",
        ]
      );
      if (categoryIds.length === 0) return;

      const pool = await this.fetchChannelsForCategories(
        sourceIds,
        categoryIds,
        MediaType.serie
      );
      if (pool.length === 0) return;

      const eligible: Channel[] = [];
      const seenNorms = new Set<string>();

      // 1. Identify channels directly from folders that match Korean metadata or tags
      for (const ch of pool) {
        const cached = this.tmdbEnrichment.getEnrichmentSync(ch);
        const isKorean =
          this.isTmdbKorean(cached) || this.hasKoreanNameTag(ch.name || "");
        if (isKorean) {
          const norm = this.versionMatching.normalizeNumberTokens(
            normalizeForComparison(cleanMediaTitle(ch.name))
          );
          if (!seenNorms.has(norm)) {
            seenNorms.add(norm);
            eligible.push(ch);
          }
        }
      }

      // 2. Discover Korean series from TMDB to identify & enrich eligible titles from these folders
      if (this.tmdbConfig.isEnabled()) {
        try {
          const tmdbPages = await Promise.allSettled([
            this.tmdbEnrichment.getKoreanTv(1),
            this.tmdbEnrichment.getKoreanTv(2),
          ]);
          const tmdbItems: any[] = [];
          for (const res of tmdbPages) {
            if (res.status === "fulfilled" && Array.isArray(res.value)) {
              tmdbItems.push(...res.value);
            }
          }

          for (const item of tmdbItems) {
            const matched = this.matchItemToFolderPool(item, true, pool);
            if (matched && matched.id) {
              const norm = this.versionMatching.normalizeNumberTokens(
                normalizeForComparison(cleanMediaTitle(matched.name))
              );
              if (!seenNorms.has(norm)) {
                seenNorms.add(norm);
                eligible.push(matched);
                this.tmdbEnrichment.seedEnrichmentFromTrending(matched, item);
              }
            }
          }
        } catch (tmdbErr) {
          console.warn("TMDB Korean series lookup error:", tmdbErr);
        }
      }

      if (eligible.length > 0) {
        const shuffled = this.shuffleRowSelection(
          eligible,
          "lighthouse_shuffled_korean_series",
          24
        );
        this.upsertDiscoveryRow({
          id: "row-korean-series",
          title: "Korean Series",
          icon: "tv",
          items: shuffled,
        });

        // Enqueue visible items for background TMDB enrichment
        for (const item of shuffled.slice(0, 10)) {
          this.tmdbEnrichment.enqueue(item, "normal");
        }
      }
    } catch (err) {
      console.warn("Failed to load Korean Series row:", err);
    }
  }

  private async findKoreanCategoryIds(
    sourceIds: number[],
    mediaType: MediaType,
    targetFolderNames: string[]
  ): Promise<number[]> {
    const matchedCategoryIds: number[] = [];
    const normalizedTargets = targetFolderNames.map((n) => n.trim().toUpperCase());

    for (const [id, name] of this.groupsMap.entries()) {
      if (normalizedTargets.includes(name.trim().toUpperCase())) {
        matchedCategoryIds.push(id);
      }
    }

    for (const target of targetFolderNames) {
      try {
        const categories = await this.fetchSafe({
          source_ids: sourceIds,
          view_type: ViewMode.Categories,
          media_types: [mediaType],
          query: target,
          page: 1,
          sort: SortType.alphabeticalAscending,
          use_keywords: false,
        });

        for (const cat of categories) {
          if (
            cat.id &&
            cat.name &&
            normalizedTargets.includes(cat.name.trim().toUpperCase()) &&
            !matchedCategoryIds.includes(cat.id)
          ) {
            matchedCategoryIds.push(cat.id);
            this.groupsMap.set(cat.id, cat.name);
          }
        }
      } catch {
        // ignore
      }
    }

    return matchedCategoryIds;
  }

  private async fetchChannelsForCategories(
    sourceIds: number[],
    categoryIds: number[],
    mediaType: MediaType
  ): Promise<Channel[]> {
    const allChannels: Channel[] = [];
    for (const catId of categoryIds) {
      const page1 = await this.fetchSafe({
        source_ids: sourceIds,
        view_type: ViewMode.All,
        group_id: catId,
        media_types: [mediaType],
        page: 1,
        sort: SortType.provider,
        use_keywords: false,
      });

      if (!page1 || page1.length === 0) continue;
      allChannels.push(...page1);

      if (page1.length >= 36) {
        const pagePromises: Promise<Channel[]>[] = [];
        for (let p = 2; p <= 15; p++) {
          pagePromises.push(
            this.fetchSafe({
              source_ids: sourceIds,
              view_type: ViewMode.All,
              group_id: catId,
              media_types: [mediaType],
              page: p,
              sort: SortType.provider,
              use_keywords: false,
            })
          );
        }
        const remaining = await Promise.all(pagePromises);
        for (const batch of remaining) {
          if (batch && batch.length > 0) {
            allChannels.push(...batch);
          }
        }
      }
    }
    return allChannels;
  }

  private matchItemToFolderPool(
    item: any,
    isTv: boolean,
    folderPool: Channel[]
  ): Channel | null {
    const candidateTitles: string[] = [];
    if (isTv) {
      if (item.name) candidateTitles.push(item.name);
      if (item.original_name && item.original_name !== item.name) {
        candidateTitles.push(item.original_name);
      }
    } else {
      if (item.title) candidateTitles.push(item.title);
      if (item.original_title && item.original_title !== item.title) {
        candidateTitles.push(item.original_title);
      }
    }

    if (candidateTitles.length === 0) return null;

    const dateStr = item.release_date || item.first_air_date;
    const targetYear =
      dateStr && dateStr.length >= 4
        ? parseInt(dateStr.substring(0, 4), 10)
        : undefined;

    for (const rawTitle of candidateTitles) {
      const clean = cleanMediaTitle(rawTitle);
      const norm = this.versionMatching.normalizeNumberTokens(
        normalizeForComparison(clean)
      );

      const poolMatch = this.findBestCatalogMatch(
        norm,
        clean,
        targetYear,
        folderPool,
        isTv
      );
      if (poolMatch) {
        return poolMatch;
      }
    }

    return null;
  }

  private isTmdbKorean(enrichment?: TmdbMediaEnrichment): boolean {
    if (!enrichment) return false;
    if (enrichment.originalLanguage?.toLowerCase() === "ko") return true;
    if (
      enrichment.originCountry &&
      enrichment.originCountry.some((c) => c.toUpperCase() === "KR")
    ) {
      return true;
    }
    return false;
  }

  private hasKoreanNameTag(name: string): boolean {
    if (!name) return false;
    return (
      /\b(?:korean|k-drama|kdrama|korea)\b/i.test(name) ||
      /(?:\[|\(|\b)(?:kr|kor)(?:\]|\)|\b)/i.test(name)
    );
  }

  private shuffleRowSelection(
    items: Channel[],
    storageKey: string,
    limit: number = 24
  ): Channel[] {
    if (!items || items.length === 0) return [];
    if (items.length <= 1) return [...items];

    let prevIds: number[] = [];
    try {
      const stored = sessionStorage.getItem(storageKey);
      if (stored) {
        prevIds = JSON.parse(stored);
      }
    } catch {
      // ignore
    }

    const prevSet = new Set(prevIds);
    const freshItems: Channel[] = [];
    const repeatedItems: Channel[] = [];

    for (const item of items) {
      if (item.id && prevSet.has(item.id)) {
        repeatedItems.push(item);
      } else {
        freshItems.push(item);
      }
    }

    this.fisherYatesShuffle(freshItems);
    this.fisherYatesShuffle(repeatedItems);

    const combined = [...freshItems, ...repeatedItems];
    const selection = combined.slice(0, limit);

    if (freshItems.length === 0) {
      this.fisherYatesShuffle(selection);
    }

    try {
      const currentIds = selection
        .map((ch) => ch.id)
        .filter((id): id is number => id != null);
      sessionStorage.setItem(storageKey, JSON.stringify(currentIds));
    } catch {
      // ignore
    }

    return selection;
  }

  private fisherYatesShuffle<T>(arr: T[]): void {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }

  deduplicateContinueWatching(history: Channel[]): Channel[] {
    this.groupedHistoryIds.clear();
    if (!history || history.length === 0) return [];

    interface GroupCandidate {
      representative: Channel;
      isTv: boolean;
      clean: string;
      norm: string;
      year?: string;
      allHistoryIds: number[];
    }

    const groups: GroupCandidate[] = [];

    for (const h of history) {
      if (!h || !h.id) continue;

      const isTv = this.isTvShow(h);
      const clean = this.getCleanTitleForChannel(h);
      const norm = this.versionMatching.normalizeNumberTokens(
        normalizeForComparison(clean)
      );
      const year = extractYear(h.name);

      // Check if this item matches an existing group of the same media type
      const match = groups.find((g) => {
        if (g.isTv !== isTv) return false;

        // If both are TV episodes belonging to the exact same series_id, they match
        if (
          isTv &&
          g.representative.series_id != null &&
          h.series_id != null &&
          g.representative.series_id === h.series_id
        ) {
          return true;
        }

        // Compare normalized titles
        const sameNorm = g.norm === norm;
        const sameClean = g.clean.toLowerCase() === clean.toLowerCase();

        let isTitleMatch = sameNorm || sameClean;
        if (!isTitleMatch) {
          const dice = calculateDiceSimilarity(g.norm, norm);
          const token = calculateTokenSimilarity(g.norm, norm);
          if (Math.max(dice, token) >= 0.88) {
            isTitleMatch = true;
          }
        }

        if (!isTitleMatch) return false;

        // Verify years if both present (for movies only)
        if (!isTv && g.year && year) {
          const y1 = parseInt(g.year, 10);
          const y2 = parseInt(year, 10);
          if (!isNaN(y1) && !isNaN(y2) && Math.abs(y1 - y2) > 1) {
            return false;
          }
        }

        return true;
      });

      if (match) {
        // Group already exists. The history is ordered by last_watched DESC,
        // so the representative item remains the most recently watched version!
        if (!match.allHistoryIds.includes(h.id)) {
          match.allHistoryIds.push(h.id);
        }
        if (!match.year && year) {
          match.year = year;
        }
      } else {
        // New group
        const newGroup: GroupCandidate = {
          representative: h,
          isTv,
          clean,
          norm,
          year,
          allHistoryIds: [h.id],
        };
        groups.push(newGroup);
      }
    }

    // Store history IDs for complete removal
    for (const g of groups) {
      if (g.representative.id) {
        this.groupedHistoryIds.set(g.representative.id, g.allHistoryIds);
      }
    }

    return groups.map((g) => g.representative);
  }

  isTvShow(channel?: Channel): boolean {
    if (!channel) return false;
    if (channel.media_type === MediaType.serie) return true;
    if (
      channel.season_id != null ||
      channel.series_id != null ||
      channel.episode_num != null
    ) {
      return true;
    }
    const name = channel.name || "";
    if (
      /\b(?:s\d{1,2}\s*e\d{1,2}|season\s*\d+|\b\d{1,2}x\d{1,2}\b)/i.test(name)
    ) {
      return true;
    }
    return false;
  }

  isMovie(channel?: Channel): boolean {
    return !this.isTvShow(channel);
  }

  getCleanTitle(itemOrRaw?: Channel | string): string {
    if (!itemOrRaw) return "Untitled";
    if (typeof itemOrRaw === "string") {
      return cleanMediaTitle(itemOrRaw);
    }
    return this.getCleanTitleForChannel(itemOrRaw);
  }

  getSeriesTitle(channel: Channel): string {
    if (!channel) return "Untitled";

    if (channel.series_id != null) {
      const key = `${channel.source_id}_${channel.series_id}`;
      if (this.seriesNameMap.has(key)) {
        return cleanMediaTitle(this.seriesNameMap.get(key));
      }
      for (const [mapKey, name] of this.seriesNameMap.entries()) {
        if (mapKey.endsWith(`_${channel.series_id}`)) {
          return cleanMediaTitle(name);
        }
      }
      if (this.loadedSeries && this.loadedSeries.length > 0) {
        const sMatch = this.loadedSeries.find(
          (s) =>
            (channel.source_id == null || s.source_id === channel.source_id) &&
            (s.url === String(channel.series_id) || s.id === channel.series_id)
        );
        if (sMatch?.name) {
          return cleanMediaTitle(sMatch.name);
        }
      }
    }

    // Strip season and episode tokens from channel.name
    const raw = cleanMediaTitle(channel.name || "");
    const stripped = raw
      .replace(/\s*[-:]?\s*(?:s\d{1,2}\s*e\d{1,2}|season\s*\d+|s\d{1,2}\b|episode\s*\d+|e\d{1,2}\b|\b\d{1,2}x\d{1,2}\b).*$/i, "")
      .trim();

    if (stripped.length > 0) {
      return stripped;
    }
    return raw || "Untitled";
  }

  getCleanTitleForChannel(channel: Channel): string {
    if (!channel) return "Untitled";

    if (this.isTvShow(channel)) {
      return this.getSeriesTitle(channel);
    }

    return cleanMediaTitle(channel.name);
  }

  getContinueWatchingTitle(channel: Channel): string {
    if (!this.isTvShow(channel)) {
      return this.getCleanTitleForChannel(channel);
    }

    const rawName = channel.name || "";
    const seriesTitle = this.getSeriesTitle(channel);
    let episodeTitle = cleanMediaTitle(rawName);

    if (episodeTitle.toLowerCase().startsWith(seriesTitle.toLowerCase())) {
      episodeTitle = episodeTitle.slice(seriesTitle.length);
    }

    episodeTitle = episodeTitle
      .replace(/^\s*[-:|]\s*/, "")
      .replace(/^\b(?:s\d{1,2}\s*e\d{1,3}|\d{1,2}x\d{1,3}|e\d{1,3}|ep(?:isode)?\s*\d{1,3})\b\s*[-:|]?\s*/i, "")
      .trim();

    const seasonNum = this.extractSeasonNumber(rawName, 0);
    const episodeNum =
      channel.episode_num != null && channel.episode_num > 0
        ? channel.episode_num
        : this.extractEpisodeNumber(rawName, 0);

    const episodeCode =
      seasonNum > 0 && episodeNum > 0
        ? `S${String(seasonNum).padStart(2, "0")}E${String(episodeNum).padStart(2, "0")}`
        : episodeNum > 0
          ? `Episode ${episodeNum}`
          : "";

    if (episodeTitle && episodeTitle.toLowerCase() !== seriesTitle.toLowerCase()) {
      return episodeCode ? `${episodeCode} · ${episodeTitle}` : episodeTitle;
    }

    return episodeCode || seriesTitle;
  }

  parseYear(raw?: string): string | undefined {
    return extractYear(raw);
  }

  parseQuality(raw?: string): string | undefined {
    return extractQuality(raw);
  }

  /**
   * Assembles a diverse, balanced, and deduplicated candidate pool of ~20 to 30 titles for the Hero banner.
   * Ensures both Movies and TV Shows are represented when available, prioritizes items with valid
   * backdrops/TMDB enrichment, deduplicates grouped versions, and shuffles the pool for freshness.
   */
  private buildHeroPool(
    movies: Channel[],
    series: Channel[],
    recommended: Channel[],
  ): HeroItem[] {
    const targetPoolSize = 24; // ~20 to 30 titles
    const halfTarget = Math.floor(targetPoolSize / 2); // 12

    // 1. Separate recommendations into movies & series
    const recMovies: Channel[] = [];
    const recSeries: Channel[] = [];
    for (const r of recommended) {
      if (this.isTvShow(r)) {
        recSeries.push(r);
      } else {
        recMovies.push(r);
      }
    }

    // 2. Score candidate function: prioritize items with valid backdrop / TMDB enrichment
    const getHeroScore = (c: Channel): number => {
      let score = 0;
      const cached = this.tmdbEnrichment.getEnrichmentSync(c);
      if (cached?.backdropPath) score += 60;
      else if (cached?.posterPath) score += 25;
      if (cached?.logoPath) score += 20;
      if (c.favorite) score += 15;
      const q = extractQuality(c.name);
      if (q === "4K UHD") score += 10;
      else if (q === "1080p") score += 5;
      return score;
    };

    // 3. Helper to check duplicate versions across candidates
    const isDuplicateVersion = (cand: Channel, list: Channel[]): boolean => {
      const clean = cleanMediaTitle(cand.name).toLowerCase();
      const norm = this.versionMatching.normalizeNumberTokens(
        normalizeForComparison(clean)
      );
      const year = extractYear(cand.name);

      for (const item of list) {
        const itemClean = cleanMediaTitle(item.name).toLowerCase();
        if (itemClean === clean) return true;
        const itemNorm = this.versionMatching.normalizeNumberTokens(
          normalizeForComparison(itemClean)
        );
        if (itemNorm === norm) {
          const itemYear = extractYear(item.name);
          if (!year || !itemYear || year === itemYear) return true;
        }
        if (calculateTokenSimilarity(clean, itemClean) > 0.88) {
          return true;
        }
      }
      return false;
    };

    // 4. Collect and deduplicate movie candidates
    const rawMovies = [...recMovies, ...movies].filter(
      (m) => m.image && m.image.startsWith("http"),
    );
    rawMovies.sort((a, b) => getHeroScore(b) - getHeroScore(a));

    const selectedMovies: Channel[] = [];
    for (const m of rawMovies) {
      if (!isDuplicateVersion(m, selectedMovies)) {
        selectedMovies.push(m);
      }
      if (selectedMovies.length >= 25) break;
    }

    // 5. Collect and deduplicate series candidates
    const rawSeries = [...recSeries, ...series].filter(
      (s) => s.image && s.image.startsWith("http"),
    );
    rawSeries.sort((a, b) => getHeroScore(b) - getHeroScore(a));

    const selectedSeries: Channel[] = [];
    for (const s of rawSeries) {
      if (!isDuplicateVersion(s, selectedSeries)) {
        selectedSeries.push(s);
      }
      if (selectedSeries.length >= 25) break;
    }

    // 6. Balance Movies and Series
    let poolMovies: Channel[] = [];
    let poolSeries: Channel[] = [];

    if (selectedMovies.length > 0 && selectedSeries.length > 0) {
      const countM = Math.min(selectedMovies.length, halfTarget);
      const countS = Math.min(selectedSeries.length, halfTarget);
      poolMovies = selectedMovies.slice(0, countM);
      poolSeries = selectedSeries.slice(0, countS);

      const remaining = targetPoolSize - (poolMovies.length + poolSeries.length);
      if (remaining > 0) {
        if (selectedMovies.length > poolMovies.length) {
          poolMovies.push(
            ...selectedMovies.slice(poolMovies.length, poolMovies.length + remaining)
          );
        } else if (selectedSeries.length > poolSeries.length) {
          poolSeries.push(
            ...selectedSeries.slice(poolSeries.length, poolSeries.length + remaining)
          );
        }
      }
    } else if (selectedMovies.length > 0) {
      poolMovies = selectedMovies.slice(0, targetPoolSize);
    } else if (selectedSeries.length > 0) {
      poolSeries = selectedSeries.slice(0, targetPoolSize);
    }

    // 7. Interleave to avoid long streaks of one type
    const combinedPool: Channel[] = [];
    const maxLen = Math.max(poolMovies.length, poolSeries.length);
    for (let i = 0; i < maxLen; i++) {
      if (i < poolMovies.length) combinedPool.push(poolMovies[i]);
      if (i < poolSeries.length) combinedPool.push(poolSeries[i]);
    }

    // 8. Controlled shuffle: shuffle the initial pool so sessions don't always start with the same title
    const shuffled = this.shufflePool(combinedPool);

    // 9. Map to HeroItem, enqueuing high priority for first 4 items and normal for remaining
    return shuffled.map((ch, idx) => this.toHeroItem(ch, idx < 4 ? "high" : "normal"));
  }

  private shufflePool<T>(array: T[]): T[] {
    const copy = [...array];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  toHeroItem(channel: Channel, priority: 'high' | 'normal' = 'high'): HeroItem {
    const isSeries = this.isTvShow(channel);
    let year = extractYear(channel.name);
    const quality = extractQuality(channel.name);
    const rawGenre = channel.group_id ? this.groupsMap.get(channel.group_id) : undefined;
    let genre = cleanCategoryTitle(rawGenre);
    const cleanTitle = cleanMediaTitle(channel.name);
    let description = selectSynopsis(channel);
    let imageUrl = channel.image;
    let rating: number | undefined;
    let logoUrl: string | undefined;

    // Check TMDB cached enrichment
    const cached = this.tmdbEnrichment.getEnrichmentSync(channel);
    if (cached) {
      if (cached.backdropPath) {
        const bd = getTmdbBackdropUrl(cached.backdropPath, 'w1280');
        if (bd) imageUrl = bd;
      }
      if (cached.logoPath) {
        logoUrl = getTmdbLogoUrl(cached.logoPath, 'w500');
      }
      if (cached.overview) {
        description = cached.overview;
      }
      if (cached.releaseYear) {
        year = cached.releaseYear;
      }
      if (cached.genres && cached.genres.length > 0) {
        genre = cached.genres[0];
      }
      if (cached.rating) {
        rating = cached.rating;
      }
    }

    // Queue background enrichment for hero if configured
    if (this.tmdbConfig.isEnabled()) {
      this.tmdbEnrichment.enqueue(channel, priority);
    }

    return {
      channel,
      cleanTitle,
      year,
      quality,
      genre,
      mediaTypeLabel: isSeries ? "SERIES" : "MOVIE",
      description,
      imageUrl,
      logoUrl,
      favorite: channel.favorite,
      rating,
    };
  }

  applyEnrichmentUpdate(enrichment: TmdbMediaEnrichment): void {
    if (!enrichment.providerItemId) return;

    const matches = [
      ...this.masterHeroItems.filter((h) => h.channel.id === enrichment.providerItemId),
      ...this.heroItems.filter((h) => h.channel.id === enrichment.providerItemId),
    ];

    for (const heroMatch of matches) {
      if (enrichment.backdropPath) {
        const bd = getTmdbBackdropUrl(enrichment.backdropPath, 'w1280');
        if (bd) heroMatch.imageUrl = bd;
      }
      if (enrichment.logoPath) {
        heroMatch.logoUrl = getTmdbLogoUrl(enrichment.logoPath, 'w500');
      }
      if (enrichment.overview) {
        heroMatch.description = enrichment.overview;
      }
      if (enrichment.releaseYear) {
        heroMatch.year = enrichment.releaseYear;
      }
      if (enrichment.genres && enrichment.genres.length > 0) {
        heroMatch.genre = enrichment.genres[0];
      }
      if (enrichment.rating) {
        heroMatch.rating = enrichment.rating;
      }
    }
  }

  getCardArtwork(channel: Channel): string | undefined {
    const cached = this.tmdbEnrichment.getEnrichmentSync(channel);
    if (cached?.posterPath) {
      const poster = getTmdbPosterUrl(cached.posterPath, 'w500');
      if (poster) return poster;
    }
    if (channel.image) return channel.image;

    // For episodes, fall back to parent series image if available
    if (this.isTvShow(channel) && channel.series_id != null) {
      const sMatch = this.loadedSeries.find(
        (s) =>
          (channel.source_id == null || s.source_id === channel.source_id) &&
          (s.url === String(channel.series_id) || s.id === channel.series_id)
      );
      if (sMatch?.image) return sMatch.image;
    }

    return undefined;
  }

  getContinueWatchingArtwork(channel: Channel): string | undefined {
    if (!channel) return undefined;
    if (this.isTvShow(channel)) {
      if (channel.series_id != null && this.loadedSeries && this.loadedSeries.length > 0) {
        const sMatch = this.loadedSeries.find(
          (s) =>
            (channel.source_id == null || s.source_id === channel.source_id) &&
            (s.url === String(channel.series_id) || s.id === channel.series_id)
        );
        if (sMatch) {
          const sArt = this.getCardArtwork(sMatch) || sMatch.image;
          if (sArt) return sArt;
        }
      }
      const cached = this.tmdbEnrichment.getEnrichmentSync(channel);
      if (cached?.backdropPath) {
        const bd = getTmdbBackdropUrl(cached.backdropPath, 'w780');
        if (bd) return bd;
      }
      if (cached?.posterPath) {
        const poster = getTmdbPosterUrl(cached.posterPath, 'w500');
        if (poster) return poster;
      }
      if (channel.id && this.episodeStillMap.has(channel.id)) {
        return this.episodeStillMap.get(channel.id);
      }
      if (channel.id && !this.inFlightStillFetches.has(channel.id)) {
        this.resolveEpisodeStill(channel);
      }
    } else {
      // For movies in landscape, prefer high-res TMDB backdrop if available
      const cached = this.tmdbEnrichment.getEnrichmentSync(channel);
      if (cached?.backdropPath) {
        const bd = getTmdbBackdropUrl(cached.backdropPath, 'w780');
        if (bd) return bd;
      }
    }
    // Fall back to standard card artwork or provider thumbnail
    return this.getCardArtwork(channel) || channel.image;
  }

  async resolveEpisodeStill(channel: Channel): Promise<void> {
    if (!channel || !channel.id || !this.isTvShow(channel)) return;
    if (this.episodeStillMap.has(channel.id) || this.inFlightStillFetches.has(channel.id)) return;
    if (!this.tmdbConfig.isEnabled()) return;

    this.inFlightStillFetches.add(channel.id);
    try {
      const seasonNum =
        channel.season_id != null && channel.season_id <= 30
          ? channel.season_id
          : this.extractSeasonNumber(channel.name);
      const epNum =
        channel.episode_num != null && channel.episode_num > 0
          ? channel.episode_num
          : this.extractEpisodeNumber(channel.name);

      // 1. Get TMDB ID: first check channel cached enrichment, or parent series
      let tmdbId: number | undefined;
      const channelCached = this.tmdbEnrichment.getEnrichmentSync(channel);
      if (channelCached?.tmdbId) {
        tmdbId = channelCached.tmdbId;
      } else {
        // Look up parent series
        const seriesChannel = await this.resolveSeriesChannel(channel);
        if (seriesChannel) {
          const seriesCached = this.tmdbEnrichment.getEnrichmentSync(seriesChannel);
          if (seriesCached?.tmdbId) {
            tmdbId = seriesCached.tmdbId;
          } else {
            const enrichedSeries = await this.tmdbEnrichment.getEnrichment(
              seriesChannel,
              true,
              'high'
            );
            if (enrichedSeries?.tmdbId) {
              tmdbId = enrichedSeries.tmdbId;
            }
          }
        }
      }

      if (tmdbId) {
        const seasonDetail = await this.tmdbEnrichment.getSeasonDetails(
          tmdbId,
          seasonNum
        );
        if (seasonDetail?.episodes && seasonDetail.episodes.length > 0) {
          const matchedEp = seasonDetail.episodes.find(
            (e) => e.episodeNumber === epNum
          );
          if (matchedEp?.stillPath) {
            // Use highest-quality available TMDB episode still ('original')
            const stillUrl = getTmdbStillUrl(matchedEp.stillPath, 'original');
            if (stillUrl) {
              this.episodeStillMap.set(channel.id, stillUrl);
            }
          }
        }
      }
    } catch (e) {
      console.warn("Failed to resolve episode still for CW card:", e);
    } finally {
      this.inFlightStillFetches.delete(channel.id);
    }
  }

  extractSeasonNumber(rawName?: string, fallback: number = 1): number {
    if (!rawName) return fallback;
    const match =
      rawName.match(/\b(?:s|season)[\s._-]*(\d+)\b/i) ||
      rawName.match(/\b(\d{1,2})x\d{1,2}\b/i);
    if (match) {
      const parsed = parseInt(match[1], 10);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    return fallback;
  }

  extractEpisodeNumber(rawName?: string, fallback: number = 1): number {
    if (!rawName) return fallback;
    const match =
      rawName.match(/\b(?:e|ep|episode)[\s._-]*(\d+)\b/i) ||
      rawName.match(/\b\d{1,2}x(\d{1,2})\b/i);
    if (match) {
      const parsed = parseInt(match[1], 10);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    return fallback;
  }

  getEpisodeLabel(channel: Channel): string | undefined {
    if (!this.isTvShow(channel)) return undefined;
    const sn =
      channel.season_id != null && channel.season_id <= 30
        ? channel.season_id
        : this.extractSeasonNumber(channel.name);
    const ep =
      channel.episode_num != null && channel.episode_num > 0
        ? channel.episode_num
        : this.extractEpisodeNumber(channel.name);
    if (sn != null && ep != null) {
      return `S${sn} • E${ep}`;
    }
    if (ep != null) {
      return `Episode ${ep}`;
    }
    return undefined;
  }

  getWatchProgress(channel: Channel): number {
    if (!channel || channel.id == null) return 0;
    const chAny = channel as any;
    if (chAny.progress != null && chAny.duration != null && chAny.duration > 0) {
      return Math.min(
        100,
        Math.max(0, Math.round((chAny.progress / chAny.duration) * 100))
      );
    }
    if (chAny.progress_percent != null && !isNaN(chAny.progress_percent) && chAny.progress_percent > 0) {
      return Math.min(100, Math.max(0, Math.round(chAny.progress_percent)));
    }
    try {
      const idsToCheck = [channel.id];
      if (this.groupedHistoryIds.has(channel.id)) {
        const grouped = this.groupedHistoryIds.get(channel.id) || [];
        for (const gId of grouped) {
          if (!idsToCheck.includes(gId)) idsToCheck.push(gId);
        }
      }

      const storeRaw = localStorage.getItem("fred_tv_watch_progress");
      if (storeRaw) {
        const store = JSON.parse(storeRaw);
        if (store) {
          for (const id of idsToCheck) {
            if (store[id]) {
              const entry = store[id];
              const pct =
                typeof entry === "number"
                  ? entry
                  : entry.percent ||
                    (entry.time && entry.duration && entry.duration > 0
                      ? (entry.time / entry.duration) * 100
                      : 0);
              if (pct > 0) return Math.min(100, Math.max(1, Math.round(pct)));
            }
          }
        }
      }

      for (const id of idsToCheck) {
        const itemKey =
          localStorage.getItem(`watch_progress_${id}`) ||
          localStorage.getItem(`playback_pos_${id}`);
        if (itemKey) {
          const val = parseFloat(itemKey);
          if (!isNaN(val) && val > 0) {
            const durKey = localStorage.getItem(`playback_dur_${id}`);
            if (durKey) {
              const dur = parseFloat(durKey);
              if (!isNaN(dur) && dur > 0) {
                return Math.min(100, Math.max(1, Math.round((val / dur) * 100)));
              }
            }
            return Math.min(100, Math.max(1, Math.round(val <= 1 ? val * 100 : val)));
          }
        }
      }
    } catch {
      // ignore
    }
    return 0;
  }

  getCardYear(channel: Channel): string | undefined {
    const cached = this.tmdbEnrichment.getEnrichmentSync(channel);
    return cached?.releaseYear || extractYear(channel.name);
  }

  enqueueVisibleCardsEnrichment(): void {
    if (!this.tmdbConfig.isEnabled()) return;
    const candidates = this.discoveryRows.slice(0, 2);
    for (const row of candidates) {
      for (const item of row.items.slice(0, 10)) {
        this.tmdbEnrichment.enqueue(item, 'normal');
      }
    }
  }

  onImageError(channelId?: number) {
    if (channelId) {
      this.imageErrorSet.add(channelId);
    }
  }

  isImageBroken(channelId?: number): boolean {
    return channelId ? this.imageErrorSet.has(channelId) : true;
  }

  handleCardClick(channel: Channel, rowId?: string) {
    if (rowId === 'row-continue-watching') {
      this.resume.emit(channel);
      return;
    }
    if (channel.media_type === MediaType.serie) {
      this.versionMatching.savePreferredVersion(
        channel,
        this.versionMatching.channelToVersion(channel, true)
      );
      this.tvDetailService.openTvDetail(channel);
    } else if (channel.media_type === MediaType.movie) {
      const isEpisode = !!(
        channel.season_id != null ||
        channel.episode_num != null ||
        channel.series_id != null ||
        /\b(?:s\d{1,2}\s*e\d{1,2}|season\s*\d+|\b\d{1,2}x\d{1,2}\b)/i.test(channel.name || "")
      );
      if (isEpisode) {
        this.play.emit(channel);
      } else {
        this.versionMatching.savePreferredVersion(
          channel,
          this.versionMatching.channelToVersion(channel, true)
        );
        this.movieDetailService.openMovieDetail(channel);
      }
    } else {
      this.play.emit(channel);
    }
  }

  onCardMouseEnter(event: MouseEvent): void {
    const card = event.currentTarget as HTMLElement;
    if (!card) return;
    const wrap = card.querySelector('.overlay-title-wrap') as HTMLElement;
    const text = card.querySelector('.overlay-title-text') as HTMLElement;
    if (!wrap || !text) return;

    wrap.classList.remove('is-overflowing');
    text.style.removeProperty('--marquee-start');
    text.style.removeProperty('--marquee-end');
    text.style.removeProperty('--marquee-duration');

    const containerWidth = wrap.clientWidth;
    const textWidth = text.scrollWidth;

    if (textWidth > containerWidth + 2) {
      const distance = containerWidth + textWidth;
      // Smooth, natural reading speed of ~45px/sec
      const duration = Math.max(4.5, distance / 45);
      text.style.setProperty('--marquee-start', `${containerWidth}px`);
      text.style.setProperty('--marquee-end', `-${textWidth}px`);
      text.style.setProperty('--marquee-duration', `${duration.toFixed(2)}s`);
      wrap.classList.add('is-overflowing');
    }
  }

  onCardMouseLeave(event: MouseEvent): void {
    const card = event.currentTarget as HTMLElement;
    if (!card) return;
    const wrap = card.querySelector('.overlay-title-wrap') as HTMLElement;
    const text = card.querySelector('.overlay-title-text') as HTMLElement;
    if (wrap) {
      wrap.classList.remove('is-overflowing');
    }
    if (text) {
      text.style.removeProperty('--marquee-start');
      text.style.removeProperty('--marquee-end');
      text.style.removeProperty('--marquee-duration');
    }
  }

  async goToDetail(channel: Channel, event?: Event): Promise<void> {
    if (event) {
      event.stopPropagation();
    }

    if (this.isTvShow(channel)) {
      const seriesChannel = await this.resolveSeriesChannel(channel);
      if (seriesChannel) {
        this.versionMatching.savePreferredVersion(
          seriesChannel,
          this.versionMatching.channelToVersion(seriesChannel, true)
        );
        this.tvDetailService.openTvDetail(seriesChannel);
      }
    } else {
      this.versionMatching.savePreferredVersion(
        channel,
        this.versionMatching.channelToVersion(channel, true)
      );
      this.movieDetailService.openMovieDetail(channel);
    }
  }

  private async resolveSeriesChannel(channel: Channel): Promise<Channel> {
    if (
      channel.media_type === MediaType.serie &&
      channel.series_id == null &&
      channel.season_id == null
    ) {
      return channel;
    }

    const clean = this.getCleanTitleForChannel(channel);
    const sourceIds = channel.source_id
      ? [channel.source_id]
      : Array.from(this.memory.Sources.keys());
    const seriesIdStr =
      channel.series_id != null ? String(channel.series_id) : undefined;

    // 1. Check cached loaded series
    if (this.loadedSeries && this.loadedSeries.length > 0) {
      const match = this.loadedSeries.find(
        (s) =>
          (channel.source_id == null || s.source_id === channel.source_id) &&
          seriesIdStr != null &&
          (s.url === seriesIdStr || String(s.id) === seriesIdStr)
      );
      if (match) return match;
    }

    // 2. Query SQLite for series by clean title
    try {
      const results = (await invoke("search", {
        filters: {
          source_ids: sourceIds,
          view_type: ViewMode.All,
          media_types: [MediaType.serie],
          query: clean,
          use_keywords: false,
          page: 1,
          sort: SortType.alphabeticalAscending,
        },
      })) as Channel[];

      if (results && results.length > 0) {
        if (seriesIdStr) {
          const exact = results.find(
            (s) => s.url === seriesIdStr || String(s.id) === seriesIdStr
          );
          if (exact) return exact;
        }

        const targetNorm = this.versionMatching.normalizeNumberTokens(
          normalizeForComparison(clean)
        );
        const normMatch = results.find((s) => {
          const candClean = cleanMediaTitle(s.name);
          const candNorm = this.versionMatching.normalizeNumberTokens(
            normalizeForComparison(candClean)
          );
          return candNorm === targetNorm;
        });
        if (normMatch) return normMatch;

        return results[0];
      }
    } catch (e) {
      console.warn("Failed to find series in SQLite:", e);
    }

    // 3. Fallback: synthesize series Channel with correct series ID and source ID
    return {
      id: channel.series_id || channel.id,
      name: clean,
      media_type: MediaType.serie,
      source_id: channel.source_id,
      url: seriesIdStr,
      image: channel.image,
      favorite: false,
    };
  }

  async removeFromContinueWatching(channel: Channel, event?: Event): Promise<void> {
    if (event) {
      event.stopPropagation();
    }

    const idsToRemove =
      this.groupedHistoryIds.get(channel.id!) || (channel.id ? [channel.id] : []);

    try {
      await Promise.all(
        idsToRemove.map((id) => invoke("remove_from_history", { id }))
      );

      // Remove from Continue Watching row
      const cwRow = this.masterDiscoveryRows.find(
        (r) => r.id === "row-continue-watching"
      );
      if (cwRow) {
        cwRow.items = cwRow.items.filter(
          (item) => !idsToRemove.includes(item.id!) && item.id !== channel.id
        );
        cwRow.badge = `${cwRow.items.length}`;
        if (cwRow.items.length === 0) {
          this.masterDiscoveryRows = this.masterDiscoveryRows.filter(
            (r) => r.id !== "row-continue-watching"
          );
        }
      }
      this.applyContentPreferences();

      this.toastr.success(
        `Removed "${this.getCleanTitleForChannel(channel)}" from Continue Watching`
      );
    } catch (err) {
      console.error("Failed to remove from Continue Watching:", err);
      this.toastr.error("Failed to remove title from Continue Watching");
    }
  }

  handleHeroPlay(hero: HeroItem) {
    if (hero.channel.media_type === MediaType.serie) {
      this.tvDetailService.openTvDetail(hero.channel);
    } else {
      this.play.emit(hero.channel);
    }
  }

  handleHeroDetails(hero: HeroItem) {
    if (hero.channel.media_type === MediaType.serie) {
      this.tvDetailService.openTvDetail(hero.channel);
    } else if (hero.channel.media_type === MediaType.movie) {
      this.movieDetailService.openMovieDetail(hero.channel);
    } else {
      this.play.emit(hero.channel);
    }
  }

  async toggleFavorite(channel: Channel, event: Event) {
    event.stopPropagation();
    const wasFavorite = channel.favorite;
    const call = wasFavorite ? "unfavorite_channel" : "favorite_channel";
    try {
      await invoke(call, { channelId: channel.id });
      channel.favorite = !wasFavorite;
      const title = cleanMediaTitle(channel.name);
      if (wasFavorite) {
        this.toastr.success(`Removed "${title}" from favorites`);
      } else {
        this.toastr.success(`Added "${title}" to favorites`);
      }
    } catch {
      this.toastr.error("Failed to update favorite status");
    }
  }

  getRecommendationLabel(hero?: HeroItem): string | undefined {
    if (!hero || hero.rating == null || hero.rating <= 0) return undefined;
    const r = hero.rating;
    if (r <= 10) {
      return `Recommended ${Math.round(r * 10)}%`;
    }
    return `Recommended ${Math.round(r)}%`;
  }

  isWatched(channel?: Channel): boolean {
    if (!channel || channel.id == null) return false;
    return this.groupedHistoryIds.has(channel.id);
  }

  goToLiveTV() {
    this.navigateTab.emit(NavTab.LiveTV);
  }

  goToProfile() {
    this.navigateTab.emit(NavTab.Profile);
  }

  goToSettings() {
    this.navigateTab.emit(NavTab.Settings);
  }
}

