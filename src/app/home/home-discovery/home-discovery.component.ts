import {
  Component,
  EventEmitter,
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
import { TmdbEnrichmentService } from "../../services/tmdb-enrichment.service";
import { TmdbConfigService } from "../../services/tmdb-config.service";
import { getTmdbBackdropUrl, getTmdbPosterUrl } from "../../utils/tmdb-image";
import { TmdbMediaEnrichment } from "../../models/tmdb";
import { MovieDetailService } from "../../services/movie-detail.service";
import { TvDetailService } from "../../services/tv-detail.service";

@Component({
  selector: "app-home-discovery",
  templateUrl: "./home-discovery.component.html",
  styleUrl: "./home-discovery.component.css",
})
export class HomeDiscoveryComponent implements OnInit, OnDestroy {
  @Output() play = new EventEmitter<Channel>();
  @Output() openSeries = new EventEmitter<Channel>();
  @Output() navigateTab = new EventEmitter<NavTab>();

  heroItems: HeroItem[] = [];
  currentHeroIndex: number = 0;
  discoveryRows: DiscoveryRow[] = [];
  loading: boolean = true;
  hasAnyContent: boolean = false;
  groupsMap: Map<number, string> = new Map();
  imageErrorSet: Set<number> = new Set();
  isHeroHovered: boolean = false;

  private heroTimer?: any;
  private subs: Subscription[] = [];

  constructor(
    public memory: MemoryService,
    private toastr: ToastrService,
    public tmdbEnrichment: TmdbEnrichmentService,
    public tmdbConfig: TmdbConfigService,
    private movieDetailService: MovieDetailService,
    private tvDetailService: TvDetailService,
  ) {}

  ngOnInit(): void {
    this.loadDiscovery();

    this.subs.push(
      this.memory.Refresh.subscribe(() => {
        this.loadDiscovery();
      }),
    );

    // Subscribe to TMDB background enrichment updates
    this.subs.push(
      this.tmdbEnrichment.enrichmentUpdated$.subscribe((enrichment) => {
        this.applyEnrichmentUpdate(enrichment);
      }),
    );

    this.startHeroTimer();
  }

  ngOnDestroy(): void {
    this.stopHeroTimer();
    this.subs.forEach((s) => s.unsubscribe());
  }

  startHeroTimer() {
    this.stopHeroTimer();
    this.heroTimer = setInterval(() => {
      if (!this.isHeroHovered && this.heroItems.length > 1) {
        this.nextHero();
      }
    }, 7000);
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
    if (this.heroItems.length > 0) {
      this.currentHeroIndex = (this.currentHeroIndex + 1) % this.heroItems.length;
    }
  }

  prevHero() {
    if (this.heroItems.length > 0) {
      this.currentHeroIndex =
        (this.currentHeroIndex - 1 + this.heroItems.length) % this.heroItems.length;
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
    }
  }

  async loadDiscovery() {
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

      // Populate groups map
      this.groupsMap.clear();
      for (const cat of categoriesRes) {
        if (cat.id && cat.name) {
          this.groupsMap.set(cat.id, cat.name);
        }
      }

      // 2. Recommendation Engine: Intentional Scoring
      const recommendedList = this.computeRecommendations(
        historyRes,
        favoritesRes,
        moviesRes,
        seriesRes,
      );

      // 3. Select Hero candidates from top recommended items & catalog with artwork
      const heroPool = [...recommendedList, ...moviesRes, ...seriesRes].filter(
        (c) => c.image && c.image.startsWith("http"),
      );

      const uniqueHeroCandidates: Channel[] = [];
      const seenHeroNames = new Set<string>();
      for (const item of heroPool) {
        const clean = cleanMediaTitle(item.name).toLowerCase();
        if (!seenHeroNames.has(clean)) {
          seenHeroNames.add(clean);
          uniqueHeroCandidates.push(item);
        }
        if (uniqueHeroCandidates.length >= 6) break;
      }

      this.heroItems = uniqueHeroCandidates.map((c) => this.toHeroItem(c));

      // 4. Assemble Discovery Rows in exact prioritized order:
      // - Recommended for You
      // - Continue Watching
      // - Your Favorites
      // - Popular Movies
      // - Popular TV Shows
      // - Genre rows
      const rows: DiscoveryRow[] = [];

      if (recommendedList.length >= 2) {
        rows.push({
          id: "row-recommended",
          title: "Recommended for You",
          icon: "sparkles",
          items: recommendedList,
        });
      }

      if (historyRes.length > 0) {
        rows.push({
          id: "row-continue-watching",
          title: "Continue Watching",
          icon: "play-circle",
          badge: `${historyRes.length}`,
          items: historyRes,
        });
      }

      if (favoritesRes.length > 0) {
        rows.push({
          id: "row-favorites",
          title: "Your Favorites",
          icon: "star",
          badge: `${favoritesRes.length}`,
          items: favoritesRes,
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

      this.discoveryRows = rows;
      this.hasAnyContent = this.heroItems.length > 0 || this.discoveryRows.length > 0;
      this.loading = false;

      // 5. Progressively load top dynamic genre rows
      this.loadGenreRows(enabledSourceIds, categoriesRes);

      // 6. Non-blocking progressive TMDB background enrichment if enabled
      this.enqueueVisibleCardsEnrichment();
    } catch (e) {
      console.error("Failed to load discovery:", e);
      this.loading = false;
    }
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
    return scoredCandidates.slice(0, 20).map((sc) => sc.channel);
  }

  private curateColdStartRecommendations(movies: Channel[], series: Channel[]): Channel[] {
    const curated: Channel[] = [];
    const seenTitles = new Set<string>();

    const validMovies = movies.filter((m) => m.image && m.image.startsWith("http"));
    const validSeries = series.filter((s) => s.image && s.image.startsWith("http"));

    const maxLen = Math.max(validMovies.length, validSeries.length);
    for (let i = 0; i < maxLen; i++) {
      if (i < validMovies.length) {
        const title = cleanMediaTitle(validMovies[i].name).toLowerCase();
        if (!seenTitles.has(title)) {
          seenTitles.add(title);
          curated.push(validMovies[i]);
        }
      }
      if (i < validSeries.length) {
        const title = cleanMediaTitle(validSeries[i].name).toLowerCase();
        if (!seenTitles.has(title)) {
          seenTitles.add(title);
          curated.push(validSeries[i]);
        }
      }
      if (curated.length >= 20) break;
    }

    return curated;
  }

  private async loadGenreRows(sourceIds: number[], categories: Channel[]) {
    // Filter categories with recognizable genre names
    const filteredCategories = categories
      .filter((c) => {
        if (!c.name) return false;
        const cleaned = cleanCategoryTitle(c.name);
        return cleaned !== undefined && !c.name.toLowerCase().includes("xxx");
      })
      .slice(0, 8);

    const genrePromises = filteredCategories.map(async (cat) => {
      const items = await this.fetchSafe({
        source_ids: sourceIds,
        view_type: ViewMode.All,
        group_id: cat.id,
        media_types: [MediaType.movie, MediaType.serie],
        page: 1,
        sort: SortType.provider,
        use_keywords: false,
      });
      return { cat, items };
    });

    const results = await Promise.allSettled(genrePromises);
    for (const res of results) {
      if (res.status === "fulfilled" && res.value.items.length >= 2) {
        const cat = res.value.cat;
        const genreTitle = cleanCategoryTitle(cat.name) || cat.name!;
        this.discoveryRows.push({
          id: `row-genre-${cat.id}`,
          title: genreTitle,
          icon: "bookmark",
          items: res.value.items.slice(0, 24),
        });
      }
    }
  }

  getCleanTitle(raw?: string): string {
    return cleanMediaTitle(raw);
  }

  parseYear(raw?: string): string | undefined {
    return extractYear(raw);
  }

  parseQuality(raw?: string): string | undefined {
    return extractQuality(raw);
  }

  toHeroItem(channel: Channel): HeroItem {
    const isSeries = channel.media_type === MediaType.serie;
    let year = extractYear(channel.name);
    const quality = extractQuality(channel.name);
    const rawGenre = channel.group_id ? this.groupsMap.get(channel.group_id) : undefined;
    let genre = cleanCategoryTitle(rawGenre);
    const cleanTitle = cleanMediaTitle(channel.name);
    let description = selectSynopsis(channel);
    let imageUrl = channel.image;
    let rating: number | undefined;

    // Check TMDB cached enrichment
    const cached = this.tmdbEnrichment.getEnrichmentSync(channel);
    if (cached) {
      if (cached.backdropPath) {
        const bd = getTmdbBackdropUrl(cached.backdropPath, 'w1280');
        if (bd) imageUrl = bd;
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

    // Queue high-priority background enrichment for hero if configured
    if (this.tmdbConfig.isEnabled()) {
      this.tmdbEnrichment.enqueue(channel, 'high');
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
      favorite: channel.favorite,
      rating,
    };
  }

  applyEnrichmentUpdate(enrichment: TmdbMediaEnrichment): void {
    if (!enrichment.providerItemId) return;

    const heroMatch = this.heroItems.find((h) => h.channel.id === enrichment.providerItemId);
    if (heroMatch) {
      if (enrichment.backdropPath) {
        const bd = getTmdbBackdropUrl(enrichment.backdropPath, 'w1280');
        if (bd) heroMatch.imageUrl = bd;
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
    return channel.image;
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

  handleCardClick(channel: Channel) {
    if (channel.media_type === MediaType.serie) {
      this.tvDetailService.openTvDetail(channel);
    } else if (channel.media_type === MediaType.movie) {
      const isEpisode = !!(channel.season_id != null || channel.episode_num != null);
      if (isEpisode) {
        this.play.emit(channel);
      } else {
        this.movieDetailService.openMovieDetail(channel);
      }
    } else {
      this.play.emit(channel);
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

  goToLiveTV() {
    this.navigateTab.emit(NavTab.LiveTV);
  }

  goToProfile() {
    this.navigateTab.emit(NavTab.Profile);
  }
}
