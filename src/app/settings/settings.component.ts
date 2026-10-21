import { ChangeDetectorRef, Component, ElementRef, HostListener, ViewChild } from "@angular/core";
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

export type SettingsCategoryId =
  | "general"
  | "playback"
  | "library"
  | "downloads"
  | "metadata"
  | "network"
  | "system";

interface SettingsCategory {
  id: SettingsCategoryId;
  label: string;
  description: string;
  icon: string;
}

@Component({
  selector: "app-settings",
  templateUrl: "./settings.component.html",
  styleUrl: "./settings.component.css",
})
export class SettingsComponent {
  subscriptions: Subscription[] = [];
  startupPage: string = "home";

  // Sidebar categories. Groups existing settings only; no setting is duplicated.
  readonly categories: SettingsCategory[] = [
    {
      id: "general",
      label: "General",
      description: "Startup page and catalog ordering",
      icon: "M3,17V19H9V17H3M3,5V7H13V5H3M13,21V19H21V17H13V15H11V21H13M7,9V11H3V13H7V15H9V9H7M21,13V11H11V13H21M15,9H17V7H21V5H17V3H15V9Z",
    },
    {
      id: "playback",
      label: "Playback",
      description: "Audio, buffering and video engine",
      icon: "M12,2C6.48,2 2,6.48 2,12S6.48,22 12,22 22,17.52 22,12 17.52,2 12,2M10,16.5V7.5L16,12L10,16.5Z",
    },
    {
      id: "library",
      label: "Library",
      description: "Sources, sync and watch history",
      icon: "M12,3C7.58,3 4,4.79 4,7C4,9.21 7.58,11 12,11C16.42,11 20,9.21 20,7C20,4.79 16.42,3 12,3M4,9V12C4,14.21 7.58,16 12,16C16.42,16 20,14.21 20,12V9C20,11.21 16.42,13 12,13C7.58,13 4,11.21 4,9M4,14V17C4,19.21 7.58,21 12,21C16.42,21 20,19.21 20,17V14C20,16.21 16.42,18 12,18C7.58,18 4,16.21 4,14Z",
    },
    {
      id: "downloads",
      label: "Downloads",
      description: "Recording folder and save prompts",
      icon: "M5,20H19V18H5M19,9H15V3H9V9H5L12,16L19,9Z",
    },
    {
      id: "metadata",
      label: "Metadata",
      description: "TMDB artwork and enrichment",
      icon: "M18,4L20,8H17L15,4H13L15,8H12L10,4H8L10,8H7L5,4H4A2,2 0 0,0 2,6V18A2,2 0 0,0 4,20H20A2,2 0 0,0 22,18V4H18Z",
    },
    {
      id: "network",
      label: "Network",
      description: "Re-streaming to other devices",
      icon: "M12,21L15.6,16.2C14.6,15.45 13.35,15 12,15C10.65,15 9.4,15.45 8.4,16.2L12,21M12,3C7.95,3 4.21,4.34 1.2,6.6L3,9C5.5,7.12 8.62,6 12,6C15.38,6 18.5,7.12 21,9L22.8,6.6C19.79,4.34 16.05,3 12,3M12,9C9.3,9 6.81,9.89 4.8,11.4L6.6,13.8C8.1,12.67 9.97,12 12,12C14.03,12 15.9,12.67 17.4,13.8L19.2,11.4C17.19,9.89 14.7,9 12,9Z",
    },
    {
      id: "system",
      label: "System",
      description: "Tray behavior and startup refresh",
      icon: "M12,15.5A3.5,3.5 0 0,1 8.5,12A3.5,3.5 0 0,1 12,8.5A3.5,3.5 0 0,1 15.5,12A3.5,3.5 0 0,1 12,15.5M19.43,12.97C19.47,12.65 19.5,12.33 19.5,12C19.5,11.67 19.47,11.34 19.43,11L21.54,9.37C21.73,9.22 21.78,8.95 21.66,8.73L19.66,5.27C19.54,5.05 19.27,4.96 19.05,5.05L16.56,6.05C16.04,5.66 15.5,5.32 14.87,5.07L14.5,2.42C14.46,2.18 14.25,2 14,2H10C9.75,2 9.54,2.18 9.5,2.42L9.13,5.07C8.5,5.32 7.96,5.66 7.44,6.05L4.95,5.05C4.73,4.96 4.46,5.05 4.34,5.27L2.34,8.73C2.21,8.95 2.27,9.22 2.46,9.37L4.57,11C4.53,11.34 4.5,11.67 4.5,12C4.5,12.33 4.53,12.65 4.57,12.97L2.46,14.63C2.27,14.78 2.21,15.05 2.34,15.27L4.34,18.73C4.46,18.95 4.73,19.03 4.95,18.95L7.44,17.94C7.96,18.34 8.5,18.68 9.13,18.93L9.5,21.58C9.54,21.82 9.75,22 10,22H14C14.25,22 14.46,21.82 14.5,21.58L14.87,18.93C15.5,18.67 16.04,18.34 16.56,17.94L19.05,18.95C19.27,19.03 19.54,18.95 19.66,18.73L21.66,15.27C21.78,15.05 21.73,14.78 21.54,14.63L19.43,12.97Z",
    },
  ];
  activeCategory: SettingsCategoryId = "general";

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
    private cdr: ChangeDetectorRef,
  ) { }

  _getSortTypeText(sortType: SortType) {
    return getSortTypeText(sortType);
  }

  selectCategory(category: SettingsCategoryId) {
    this.activeCategory = category;
  }

  trackByCategory(_index: number, category: SettingsCategory) {
    return category.id;
  }

  onSettingsNavKeydown(event: KeyboardEvent) {
    const navKeys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!navKeys.includes(event.key)) return;
    event.preventDefault();

    const currentIndex = this.categories.findIndex((x) => x.id === this.activeCategory);
    let nextIndex = currentIndex < 0 ? 0 : currentIndex;
    switch (event.key) {
      case "ArrowDown":
        nextIndex = (nextIndex + 1) % this.categories.length;
        break;
      case "ArrowUp":
        nextIndex = (nextIndex - 1 + this.categories.length) % this.categories.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = this.categories.length - 1;
        break;
    }

    this.activeCategory = this.categories[nextIndex].id;
    const buttons = (event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>(".settings-nav-item");
    buttons[nextIndex]?.focus();
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
    this.memory.activeNavTab.next(NavTab.Settings);
    this.getSettings();
    this.getSources();
    this.loadStartupPage();
    this.loadTmdbSettings();
    this.loadTmdbCacheStats();
    if (this.memory.XtreamSourceIds.size > 0)
      this.getExpiries();
  }

  loadStartupPage() {
    this.startupPage = localStorage.getItem("fred_tv_startup_page") || "home";
  }

  onStartupPageChange() {
    localStorage.setItem("fred_tv_startup_page", this.startupPage);
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
    this.memory.RefreshSources.next(true);
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
