import { Component, ElementRef, HostListener, ViewChild } from "@angular/core";
import { debounceTime, distinctUntilChanged, fromEvent, map, Subscription } from "rxjs";
import { Settings } from "../models/settings";
import { invoke } from "@tauri-apps/api/core";
import { Router } from "@angular/router";
import { open } from "@tauri-apps/plugin-dialog";
import { Source } from "../models/source";
import { MemoryService } from "../memory.service";
import { ViewMode } from "../models/viewMode";
import { NgbModal } from "@ng-bootstrap/ng-bootstrap";
import { ConfirmDeleteModalComponent } from "../confirm-delete-modal/confirm-delete-modal.component";
import { SORT_TYPES, SortType, getSortTypeText } from "../models/sortType";
import { NavTab } from "../models/navTab";
import { Channel } from "../models/channel";
import { Filters } from "../models/filters";
import { MediaType } from "../models/mediaType";
import { ToastrService } from "ngx-toastr";
import { TmdbConfigService } from "../services/tmdb-config.service";
import { TmdbCacheService } from "../services/tmdb-cache.service";

@Component({
  selector: "app-settings",
  templateUrl: "./settings.component.html",
  styleUrl: "./settings.component.css",
})
export class SettingsComponent {
  subscriptions: Subscription[] = [];
  activeSection: 'favorites' | 'settings' = 'favorites';
  favoriteChannels: Channel[] = [];
  filteredFavorites: Channel[] = [];
  favSearchQuery: string = "";
  favMediaType: number = -1;
  loadingFavorites: boolean = false;
  mediaTypeEnum = MediaType;

  // TMDB configuration state
  tmdbEnabled: boolean = false;
  tmdbToken: string = "";
  showTmdbToken: boolean = false;
  tmdbTesting: boolean = false;
  tmdbTestMessage: string = "";
  tmdbTestSuccess: boolean | null = null;
  tmdbCacheStats: { enrichedCount: number; failedCount: number } = { enrichedCount: 0, failedCount: 0 };

  settings: Settings = {
    use_stream_caching: true,
    default_view: ViewMode.All,
    volume: 100,
    restream_port: 3000,
    enable_tray_icon: true,
    zoom: 100,
    default_sort: SortType.provider,
    enable_hwdec: true,
    always_ask_save: false,
    enable_gpu: false,
  };
  viewModeEnum = ViewMode;
  sources: Source[] = [];
  expiries: Record<number, number> = {};
  sortTypes = SORT_TYPES;
  @ViewChild("mpvParams") mpvParams!: ElementRef;

  constructor(
    private router: Router,
    public memory: MemoryService,
    private nav: Router,
    private modal: NgbModal,
    public tmdbConfig: TmdbConfigService,
    public tmdbCache: TmdbCacheService,
    private toastr: ToastrService,
  ) { }

  _getSortTypeText(sortType: SortType) {
    return getSortTypeText(sortType);
  }

  isInputFocused(): boolean {
    const activeElement = document.activeElement;
    return (
      activeElement instanceof HTMLInputElement ||
      activeElement instanceof HTMLTextAreaElement ||
      activeElement instanceof HTMLSelectElement
    );
  }

  @HostListener("document:keydown", ["$event"])
  onKeyDown(event: KeyboardEvent) {
    if (
      event.key == "Escape" ||
      event.key == "BrowserBack" ||
      (event.key == "Backspace" && !this.isInputFocused())
    ) {
      if (this.memory.ModalRef) {
        this.memory.ModalRef.close("close");
      } else {
        this.goBack();
      }
      event.preventDefault();
    }
  }

  ngOnInit(): void {
    this.memory.activeNavTab.next(NavTab.Profile);
    this.getSettings();
    this.getSources();
    this.loadFavorites();
    this.loadTmdbSettings();
    this.loadTmdbCacheStats();
    if (this.memory.XtreamSourceIds.size > 0)
      this.getExpiries();
  }

  setSection(section: 'favorites' | 'settings') {
    this.activeSection = section;
    if (section === 'favorites') {
      this.loadFavorites();
    }
  }

  setFavMediaType(type: number) {
    this.favMediaType = type;
    this.filterFavorites();
  }

  filterFavorites() {
    let list = this.favoriteChannels;
    if (this.favMediaType !== -1) {
      list = list.filter(c => c.media_type === this.favMediaType);
    }
    if (this.favSearchQuery && this.favSearchQuery.trim() !== '') {
      const q = this.favSearchQuery.toLowerCase().trim();
      list = list.filter(c => (c.name || '').toLowerCase().includes(q));
    }
    this.filteredFavorites = list;
  }

  async loadFavorites() {
    this.loadingFavorites = true;
    try {
      const sources = (await invoke("get_sources")) as Source[];
      const enabledSources = sources.filter(s => s.enabled);
      if (enabledSources.length === 0) {
        this.favoriteChannels = [];
        this.filteredFavorites = [];
        this.loadingFavorites = false;
        return;
      }
      const sourceIds = enabledSources.map(s => s.id!);
      const filters: Filters = {
        source_ids: sourceIds,
        view_type: ViewMode.Favorites,
        media_types: [MediaType.livestream, MediaType.movie, MediaType.serie],
        page: 1,
        use_keywords: false,
        sort: SortType.alphabeticalAscending,
      };
      let allFavs: Channel[] = [];
      let page = 1;
      let hasMore = true;
      while (hasMore && page <= 25) {
        filters.page = page;
        const res = (await invoke("search", { filters })) as Channel[];
        if (res && res.length > 0) {
          allFavs = allFavs.concat(res);
          hasMore = res.length === 36;
          page++;
        } else {
          hasMore = false;
        }
      }
      this.favoriteChannels = allFavs;
      this.filterFavorites();
    } catch (e) {
      console.error("Failed to load favorites", e);
    }
    this.loadingFavorites = false;
  }

  getSettings() {
    invoke("get_settings").then((x) => {
      this.settings = x as Settings;
      if (this.settings.use_stream_caching == undefined) this.settings.use_stream_caching = true;
      if (this.settings.default_view == undefined) this.settings.default_view = ViewMode.All;
      if (this.settings.volume == undefined) this.settings.volume = 100;
      if (this.settings.restream_port == undefined) this.settings.restream_port = 3000;
      if (this.settings.enable_tray_icon == undefined) this.settings.enable_tray_icon = true;
      if (this.settings.zoom == undefined) this.settings.zoom = 100;
      if (this.settings.default_sort == undefined) this.settings.default_sort = SortType.provider;
      if (this.settings.enable_hwdec == undefined) this.settings.enable_hwdec = true;
      if (this.settings.always_ask_save == undefined) this.settings.always_ask_save = false;
      if (this.settings.enable_gpu == undefined) this.settings.enable_gpu = false;
    });
  }

  getSources() {
    invoke("get_sources").then((x) => {
      this.sources = x as Source[];
      if (this.sources.length == 0) {
        this.memory.AddingAdditionalSource = false;
        this.nav.navigateByUrl("setup");
      }
    });
  }

  getExpiries() {
    invoke("get_all_expiries").then(expiries => {
      this.expiries = expiries as Record<number, number>;
    });
  }

  ngAfterViewInit(): void {
    this.subscriptions.push(
      fromEvent(this.mpvParams.nativeElement, "keyup")
        .pipe(
          map((event: any) => {
            return event.target.value;
          }),
          debounceTime(500),
          distinctUntilChanged(),
        )
        .subscribe(async () => {
          await this.updateSettings();
        }),
    );
    this.subscriptions.push(
      this.memory.RefreshSources.subscribe((_) => {
        this.getSources();
      }),
    );
  }

  addSource() {
    this.memory.AddingAdditionalSource = true;
    this.nav.navigateByUrl("setup");
  }

  async refreshAll() {
    this.memory.SeriesRefreshed.clear();
    await this.memory.tryIPC("Successfully updated all sources", "Failed to refresh sources", () =>
      invoke("refresh_all"),
    );
  }

  async goBack() {
    await this.updateSettings();
    this.memory.activeNavTab.next(NavTab.Home);
    this.router.navigateByUrl("");
  }

  async updateSettings() {
    this.settings.mpv_params = this.settings.mpv_params?.trim();
    if (this.settings.mpv_params == "")
      this.settings.mpv_params = undefined;
    await invoke("update_settings", { settings: this.settings });
  }

  async selectFolder() {
    const folder = await open({
      multiple: false,
      directory: true,
      canCreateDirectories: true,
    });
    if (folder) {
      this.settings.recording_path = folder;
      await this.updateSettings();
    }
  }

  async nuke() {
    this.memory.ModalRef = this.modal.open(ConfirmDeleteModalComponent, {
      backdrop: "static",
      size: "xl",
      keyboard: false,
    });
    this.memory.ModalRef.result.then((_) => (this.memory.ModalRef = undefined));
    this.memory.ModalRef.componentInstance.name = "ConfirmDeleteModal";
  }

  async clearHistory() {
    await this.memory.tryIPC(
      "History cleared successfully",
      "Failed to clear history",
      async () => {
        await invoke("clear_history");
      },
    );
  }

  loadTmdbSettings() {
    const cfg = this.tmdbConfig.getConfig();
    this.tmdbEnabled = cfg.enabled;
    this.tmdbToken = cfg.token || '';
  }

  async loadTmdbCacheStats() {
    this.tmdbCacheStats = await this.tmdbCache.getCacheStats();
  }

  onTmdbEnabledChange() {
    this.tmdbConfig.setEnabled(this.tmdbEnabled);
    if (this.tmdbEnabled && (!this.tmdbToken || this.tmdbToken.trim().length === 0)) {
      this.toastr.info("Please enter your TMDB API Read Access Token to enable enrichment.");
    }
  }

  onTmdbTokenChange() {
    this.tmdbConfig.setToken(this.tmdbToken);
    this.tmdbTestSuccess = null;
    this.tmdbTestMessage = '';
  }

  toggleShowTmdbToken() {
    this.showTmdbToken = !this.showTmdbToken;
  }

  async testTmdbConnection() {
    this.tmdbTesting = true;
    this.tmdbTestMessage = '';
    this.tmdbTestSuccess = null;
    try {
      const res = await this.tmdbConfig.testConnection(this.tmdbToken);
      this.tmdbTestSuccess = res.success;
      this.tmdbTestMessage = res.message;
      if (res.success) {
        this.toastr.success(res.message);
      } else {
        this.toastr.error(res.message);
      }
    } finally {
      this.tmdbTesting = false;
    }
  }

  clearTmdbToken() {
    this.tmdbToken = '';
    this.tmdbConfig.clearToken();
    this.tmdbTestSuccess = null;
    this.tmdbTestMessage = '';
    this.toastr.info("TMDB API Read Access Token cleared.");
  }

  async clearTmdbCache() {
    await this.tmdbCache.clearCache();
    await this.loadTmdbCacheStats();
    this.toastr.success("TMDB metadata cache cleared.");
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach((x) => x.unsubscribe());
  }
}
