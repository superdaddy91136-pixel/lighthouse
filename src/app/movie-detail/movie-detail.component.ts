import { Location } from '@angular/common';
import {
  AfterViewInit,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  OnInit,
  ViewChild,
} from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { invoke } from '@tauri-apps/api/core';
import { ToastrService } from 'ngx-toastr';
import { Subscription } from 'rxjs';
import { ErrorService } from '../error.service';
import { MemoryService } from '../memory.service';
import { Channel } from '../models/channel';
import { Filters } from '../models/filters';
import { MediaType } from '../models/mediaType';
import { SortType } from '../models/sortType';
import { ViewMode } from '../models/viewMode';
import { TmdbCastMember, TmdbMediaEnrichment, TmdbVideo } from '../models/tmdb';
import { MediaVersion } from '../models/version';
import { MovieDetailService } from '../services/movie-detail.service';
import { TmdbConfigService } from '../services/tmdb-config.service';
import { TmdbEnrichmentService } from '../services/tmdb-enrichment.service';
import { VersionMatchingService } from '../services/version-matching.service';
import { PlaybackService } from '../services/playback.service';
import { isInputFocused } from '../utils';
import {
  cleanMediaTitle,
  extractQuality,
  extractYear,
  selectSynopsis,
} from '../utils/media-presentation';
import {
  getTmdbBackdropUrl,
  getTmdbPosterUrl,
  getTmdbProfileUrl,
} from '../utils/tmdb-image';

@Component({
  selector: 'app-movie-detail',
  templateUrl: './movie-detail.component.html',
  styleUrl: './movie-detail.component.css',
})
export class MovieDetailComponent implements OnInit, AfterViewInit, OnDestroy {
  movie?: Channel;
  enrichment?: TmdbMediaEnrichment;

  cleanTitle: string = '';
  backdropUrl?: string;
  posterUrl?: string;
  synopsis?: string;
  isSynopsisLong: boolean = false;
  isSynopsisExpanded: boolean = false;
  releaseYear?: string;
  runtimeText?: string;
  genres: string[] = [];
  qualityBadge?: string;
  rating?: number;
  voteCount?: number;
  director?: string;
  cast: TmdbCastMember[] = [];
  trailer?: TmdbVideo;
  safeTrailerUrl?: SafeResourceUrl;
  showTrailerModal: boolean = false;

  // Versions state
  versions: MediaVersion[] = [];
  selectedVersion?: MediaVersion;
  showVersionsMenu: boolean = false;
  loadingVersions: boolean = false;

  similarMovies: Channel[] = [];
  loadingSimilar: boolean = false;
  isStartingPlayback: boolean = false;
  imageError: boolean = false;
  backdropError: boolean = false;
  castImageErrors: Set<number> = new Set();

  private subs: Subscription[] = [];
  @ViewChild('similarTrack') similarTrack?: ElementRef<HTMLDivElement>;

  constructor(
    private movieDetailService: MovieDetailService,
    private tmdbEnrichment: TmdbEnrichmentService,
    public tmdbConfig: TmdbConfigService,
    public memory: MemoryService,
    private versionMatching: VersionMatchingService,
    private elementRef: ElementRef,
    private router: Router,
    private location: Location,
    private toastr: ToastrService,
    private error: ErrorService,
    private sanitizer: DomSanitizer,
    private playbackService: PlaybackService,
  ) {}

  private resetScrollPosition(): void {
    try {
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
    } catch {
      window.scrollTo(0, 0);
    }
    if (document.documentElement) {
      document.documentElement.scrollTop = 0;
    }
    if (document.body) {
      document.body.scrollTop = 0;
    }
    const main = document.querySelector('.app-main');
    if (main) {
      main.scrollTop = 0;
    }
  }

  ngOnInit(): void {
    this.resetScrollPosition();
    const selected = this.movieDetailService.getSelectedMovie();
    if (!selected) {
      this.goBack();
      return;
    }

    this.initMovie(selected);

    // Listen for background TMDB updates
    this.subs.push(
      this.tmdbEnrichment.enrichmentUpdated$.subscribe((updated) => {
        if (this.movie && updated.providerItemId === this.movie.id) {
          this.applyEnrichment(updated);
        }
      }),
    );
  }

  ngAfterViewInit(): void {
    this.resetScrollPosition();
    setTimeout(() => this.resetScrollPosition(), 0);
  }

  ngOnDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
  }

  @HostListener('document:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent): void {
    if (
      event.key === 'Escape' ||
      event.key === 'BrowserBack' ||
      (event.key === 'Backspace' && !isInputFocused())
    ) {
      if (this.showVersionsMenu) {
        this.showVersionsMenu = false;
      } else if (this.showTrailerModal) {
        this.closeTrailer();
      } else {
        this.goBack();
      }
      event.preventDefault();
    }
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (this.showVersionsMenu) {
      const target = event.target as HTMLElement;
      const container = this.elementRef.nativeElement.querySelector(
        '.versions-dropdown-container',
      );
      if (container && !container.contains(target)) {
        this.showVersionsMenu = false;
      }
    }
  }

  initMovie(movie: Channel): void {
    this.resetScrollPosition();
    this.movie = movie;
    this.cleanTitle = cleanMediaTitle(movie.name);
    this.releaseYear = extractYear(movie.name);
    this.qualityBadge = extractQuality(movie.name);
    this.synopsis = selectSynopsis(movie);
    this.posterUrl = movie.image;
    this.backdropUrl = undefined;
    this.genres = [];
    this.rating = undefined;
    this.voteCount = undefined;
    this.director = undefined;
    this.cast = [];
    this.trailer = undefined;
    this.imageError = false;
    this.backdropError = false;
    this.castImageErrors.clear();

    // 1. Synchronous cache read
    const cached = this.tmdbEnrichment.getEnrichmentSync(movie);
    if (cached) {
      this.applyEnrichment(cached);
    }

    // 2. Cache-first async retrieval / background enrichment
    this.tmdbEnrichment.getEnrichment(movie, true, 'high').then((res) => {
      if (res && res !== cached) {
        this.applyEnrichment(res);
      }
    });

    // 3. Load "More Like This" from existing local catalog
    this.loadSimilarMovies(movie);

    // 4. Load alternative versions from provider catalog
    this.loadVersions(movie);

    // Check synopsis length
    this.checkSynopsisLength();
  }

  async loadVersions(movie: Channel): Promise<void> {
    this.loadingVersions = true;
    try {
      const vers = await this.versionMatching.findVersions(
        movie,
        this.enrichment?.releaseYear,
      );
      this.versions = vers;

      // Check for previously saved version preference
      const preferred = this.versionMatching.getPreferredVersion(
        movie,
        this.versions,
        this.enrichment?.releaseYear,
      );

      if (preferred) {
        this.selectedVersion = preferred;
        this.versions.forEach(
          (v) => (v.isSelected = v.channel.id === preferred.channel.id),
        );
        if (this.movie && this.movie.id !== preferred.channel.id) {
          this.movie = preferred.channel;
          this.qualityBadge =
            preferred.qualityBadge || extractQuality(preferred.channel.name);
        }
      } else {
        this.selectedVersion =
          this.versions.find((v) => v.channel.id === movie.id) || this.versions[0];
        this.versions.forEach(
          (v) => (v.isSelected = v.channel.id === this.selectedVersion?.channel.id),
        );
      }
    } catch (err) {
      console.warn('Failed to discover versions for movie:', err);
      this.versions = [this.versionMatching.channelToVersion(movie, true)];
      this.selectedVersion = this.versions[0];
    } finally {
      this.loadingVersions = false;
    }
  }

  toggleVersionsMenu(event?: Event): void {
    if (event) event.stopPropagation();
    this.showVersionsMenu = !this.showVersionsMenu;
  }

  selectVersion(ver: MediaVersion): void {
    if (!ver) return;
    this.showVersionsMenu = false;

    // Persist this selection for this grouped title
    this.versionMatching.savePreferredVersion(
      this.movie || ver.channel,
      ver,
      this.enrichment?.releaseYear,
    );

    if (this.movie?.id === ver.channel.id) return;

    this.movie = ver.channel;
    this.qualityBadge = ver.qualityBadge || extractQuality(ver.channel.name);
    this.selectedVersion = ver;
    this.versions.forEach(
      (v) => (v.isSelected = v.channel.id === ver.channel.id),
    );

    this.toastr.info(`Selected ${ver.badgeLabel || ver.cleanTitle}`);
  }

  applyEnrichment(enr: TmdbMediaEnrichment): void {
    this.enrichment = enr;

    if (enr.backdropPath && !this.backdropError) {
      this.backdropUrl = getTmdbBackdropUrl(enr.backdropPath, 'w1280');
    }

    if (enr.posterPath && !this.imageError) {
      const p = getTmdbPosterUrl(enr.posterPath, 'w500');
      if (p) this.posterUrl = p;
    }

    if (enr.overview) {
      this.synopsis = enr.overview;
      this.checkSynopsisLength();
    }

    if (enr.releaseYear) {
      this.releaseYear = enr.releaseYear;
    }

    if (enr.runtime) {
      this.runtimeText = this.formatRuntime(enr.runtime);
    }

    if (enr.genres && enr.genres.length > 0) {
      this.genres = enr.genres;
    }

    if (enr.rating) {
      this.rating = enr.rating;
      this.voteCount = enr.voteCount;
    }

    if (enr.director) {
      this.director = enr.director;
    }

    if (enr.cast && enr.cast.length > 0) {
      this.cast = enr.cast;
    }

    if (enr.trailers && enr.trailers.length > 0) {
      this.trailer = enr.trailers[0];
      const ytUrl = `https://www.youtube-nocookie.com/embed/${this.trailer.key}?autoplay=1`;
      this.safeTrailerUrl = this.sanitizer.bypassSecurityTrustResourceUrl(ytUrl);
    }
  }

  private checkSynopsisLength(): void {
    if (this.synopsis && this.synopsis.length > 280) {
      this.isSynopsisLong = true;
    } else {
      this.isSynopsisLong = false;
      this.isSynopsisExpanded = true;
    }
  }

  toggleSynopsis(): void {
    this.isSynopsisExpanded = !this.isSynopsisExpanded;
  }

  formatRuntime(mins?: number): string | undefined {
    if (!mins || mins <= 0) return undefined;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h > 0 && m > 0) return `${h}h ${m}m`;
    if (h > 0) return `${h}h`;
    return `${m}m`;
  }

  getActorPhoto(path?: string): string | undefined {
    return getTmdbProfileUrl(path, 'w185');
  }

  onCastImageError(actorId: number): void {
    this.castImageErrors.add(actorId);
  }

  isCastImageBroken(actorId: number): boolean {
    return this.castImageErrors.has(actorId);
  }

  hasAnyInfo(): boolean {
    return !!(
      this.releaseYear ||
      this.enrichment?.releaseDate ||
      this.runtimeText ||
      this.genres.length > 0 ||
      this.director ||
      this.rating ||
      this.enrichment?.originalLanguage ||
      this.qualityBadge
    );
  }

  async watchNow(): Promise<void> {
    if (!this.movie || this.isStartingPlayback) return;
    this.isStartingPlayback = true;

    try {
      let playChannel: Channel = {
        ...this.movie,
        id: this.movie.id,
        name: this.movie.name || this.cleanTitle,
        url: this.movie.url,
        media_type: MediaType.movie,
        source_id: this.movie.source_id,
        favorite: !!this.movie.favorite,
      };

      // Fallback: reload fresh channel data from SQLite if url or source_id is missing
      if (!playChannel.url || !playChannel.source_id) {
        try {
          const results = (await invoke('search', {
            filters: {
              source_ids: playChannel.source_id ? [playChannel.source_id] : Array.from(this.memory.Sources.keys()),
              view_type: ViewMode.All,
              media_types: [MediaType.movie],
              query: playChannel.name,
              page: 1,
              sort: SortType.provider,
              use_keywords: false,
            },
          })) as Channel[];
          const fresh = results?.find((c) => c.id === playChannel.id);
          if (fresh) {
            playChannel = {
              ...fresh,
              media_type: MediaType.movie,
              favorite: !!fresh.favorite,
            };
            this.movie = playChannel;
          }
        } catch (err) {
          console.warn('Failed to query fresh channel record:', err);
        }
      }

      await this.playbackService.playMovie(playChannel, {
        year: this.releaseYear,
        rating: this.rating ? this.rating.toFixed(1) : undefined,
        duration: this.runtimeText,
        quality: this.qualityBadge,
      });
    } catch (e) {
      console.error('Movie playback error:', e);
      this.error.handleError(e, 'Failed to start playback');
    } finally {
      this.isStartingPlayback = false;
    }
  }

  async toggleFavorite(event?: Event): Promise<void> {
    if (event) event.stopPropagation();
    if (!this.movie) return;

    const wasFavorite = this.movie.favorite;
    const call = wasFavorite ? 'unfavorite_channel' : 'favorite_channel';

    try {
      await invoke(call, { channelId: this.movie.id });
      this.movie.favorite = !wasFavorite;
      if (wasFavorite) {
        this.toastr.success(`Removed "${this.cleanTitle}" from favorites`);
      } else {
        this.toastr.success(`Added "${this.cleanTitle}" to favorites`);
      }
    } catch {
      this.toastr.error('Failed to update favorite status');
    }
  }

  openTrailer(): void {
    if (this.trailer && this.safeTrailerUrl) {
      this.showTrailerModal = true;
    }
  }

  closeTrailer(): void {
    this.showTrailerModal = false;
  }

  openTrailerExternal(): void {
    if (this.trailer?.key) {
      const url = `https://www.youtube.com/watch?v=${this.trailer.key}`;
      window.open(url, '_blank');
    }
  }

  async loadSimilarMovies(movie: Channel): Promise<void> {
    this.loadingSimilar = true;
    try {
      const sourceIds = movie.source_id
        ? [movie.source_id]
        : Array.from(this.memory.Sources.keys());

      // Query local SQLite for movies sharing the same group/category
      const filters: Filters = {
        source_ids: sourceIds,
        group_id: movie.group_id,
        media_types: [MediaType.movie],
        view_type: ViewMode.All,
        use_keywords: false,
        page: 1,
        sort: SortType.alphabeticalAscending,
      };

      let results = (await invoke('search', { filters })) as Channel[];
      let filtered = (results || []).filter((m) => m.id !== movie.id);

      // If category has few items, fallback to general movies from provider
      if (filtered.length < 4) {
        const fallbackFilters: Filters = {
          source_ids: sourceIds,
          media_types: [MediaType.movie],
          view_type: ViewMode.All,
          use_keywords: false,
          page: 1,
          sort: SortType.provider,
        };
        const fallbackRes = (await invoke('search', { filters: fallbackFilters })) as Channel[];
        const extra = (fallbackRes || []).filter((m) => m.id !== movie.id && !filtered.some(f => f.id === m.id));
        filtered = filtered.concat(extra);
      }

      this.similarMovies = filtered.slice(0, 18);
    } catch (e) {
      console.warn('Failed to load similar movies', e);
      this.similarMovies = [];
    } finally {
      this.loadingSimilar = false;
    }
  }

  selectSimilarMovie(channel: Channel): void {
    this.initMovie(channel);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  scrollSimilar(direction: 'left' | 'right'): void {
    if (!this.similarTrack) return;
    const track = this.similarTrack.nativeElement;
    const scrollAmount = track.clientWidth * 0.75;
    track.scrollBy({
      left: direction === 'left' ? -scrollAmount : scrollAmount,
      behavior: 'smooth',
    });
  }

  getSimilarArtwork(channel: Channel): string | undefined {
    const cached = this.tmdbEnrichment.getEnrichmentSync(channel);
    if (cached?.posterPath) {
      return getTmdbPosterUrl(cached.posterPath, 'w500');
    }
    return channel.image;
  }

  getSimilarYear(channel: Channel): string | undefined {
    const cached = this.tmdbEnrichment.getEnrichmentSync(channel);
    return cached?.releaseYear || extractYear(channel.name);
  }

  getSimilarTitle(raw?: string): string {
    return cleanMediaTitle(raw);
  }

  onImageError(): void {
    this.imageError = true;
    if (this.movie?.image && this.posterUrl !== this.movie.image) {
      this.posterUrl = this.movie.image;
      this.imageError = false;
    }
  }

  onBackdropError(): void {
    this.backdropError = true;
    this.backdropUrl = undefined;
  }

  goBack(): void {
    if (window.history.length > 1) {
      this.location.back();
    } else {
      this.router.navigateByUrl('');
    }
  }
}
