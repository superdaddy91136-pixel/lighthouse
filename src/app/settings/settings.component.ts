import { ChangeDetectorRef, Component, ElementRef, HostListener, ViewChild } from "@angular/core";
import { debounceTime, distinctUntilChanged, fromEvent, map, Subscription } from "rxjs";
import { Settings } from "../models/settings";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
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
  startupPage: string = "home";

  // TMDB configuration state
  tmdbEnabled: boolean = false;
  tmdbToken: string = "";
  showTmdbToken: boolean = false;
  tmdbTesting: boolean = false;
  tmdbTestMessage: string = "";
  tmdbTestSuccess: boolean | null = null;
  tmdbCacheStats: { enrichedCount: number; failedCount: number } = { enrichedCount: 0, failedCount: 0 };

  // Embedded MPV Proof of Concept (Stage 2) state
  pocActive: boolean = false;
  pocLoading: boolean = false;
  pocStatus: string = "Idle";
  pocCurrentTime: number = 0;
  pocDuration: number = 0;
  pocPaused: boolean = false;
  pocStreamName: string = "";
  pocStreamUrl: string = "";
  pocOverlayClicks: number = 0;
  pocLastIpcEvent: string = "";
  pocZOrder: "bottom" | "top" = "bottom";
  pocUnlisten: UnlistenFn | null = null;
  pocResizeObserver: ResizeObserver | null = null;
  private pocSyncScheduled: boolean = false;

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

  @HostListener("window:resize")
  onWindowResize() {
    if (this.pocActive) {
      this.syncPocVideoBounds();
      setTimeout(() => this.syncPocVideoBounds(), 50);
      setTimeout(() => this.syncPocVideoBounds(), 150);
    }
  }

  @HostListener("window:scroll")
  onWindowScroll() {
    if (this.pocActive) {
      this.syncPocVideoBounds();
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

  async startEmbeddedPoc() {
    this.pocLoading = true;
    this.pocStatus = "Initializing...";
    this.pocOverlayClicks = 0;
    try {
      const el = document.getElementById("poc-video-canvas");
      let x = 60, y = 140, width = 640, height = 360;
      if (el) {
        const rect = el.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        x = Math.round(rect.x * dpr);
        y = Math.round(rect.y * dpr);
        width = Math.round(rect.width * dpr);
        height = Math.round(rect.height * dpr);
      }

      if (this.pocUnlisten) {
        this.pocUnlisten();
        this.pocUnlisten = null;
      }

      this.pocUnlisten = await listen("embedded-poc-event", (event) => {
        try {
          const raw = event.payload as string;
          this.pocLastIpcEvent = raw;
          const parsed = JSON.parse(raw);
          if (parsed.name === "time-pos" && typeof parsed.data === "number") {
            this.pocCurrentTime = parsed.data;
          } else if (parsed.name === "pause") {
            this.pocPaused = !!parsed.data;
          } else if (parsed.name === "duration" && typeof parsed.data === "number") {
            this.pocDuration = parsed.data;
          }
          this.cdr.detectChanges();
        } catch {
          // ignore parse errors for non-json logs
        }
      });

      document.body.classList.add("embedded-poc-active");

      const res: any = await invoke("start_embedded_poc", {
        x,
        y,
        width,
        height,
        zOrder: this.pocZOrder,
      });

      this.pocActive = true;
      this.pocStatus = "Playing inside window";
      this.pocStreamName = res.name || "Test Stream";
      this.pocStreamUrl = res.url || "";
      this.setupPocResizeObserver();
      setTimeout(() => this.syncPocVideoBounds(), 50);
      setTimeout(() => this.syncPocVideoBounds(), 150);
      this.toastr.success(`Embedded MPV launched: ${this.pocStreamName}`);
    } catch (err: any) {
      this.pocStatus = `Failed: ${err}`;
      this.toastr.error(`Embedded MPV failed: ${err}`);
      document.body.classList.remove("embedded-poc-active");
    } finally {
      this.pocLoading = false;
      this.cdr.detectChanges();
    }
  }

  syncPocVideoBounds() {
    if (!this.pocActive || this.pocSyncScheduled) return;
    this.pocSyncScheduled = true;
    requestAnimationFrame(() => {
      this.pocSyncScheduled = false;
      if (!this.pocActive) return;
      const el = document.getElementById("poc-video-canvas");
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const x = Math.round(rect.x * dpr);
      const y = Math.round(rect.y * dpr);
      const width = Math.round(rect.width * dpr);
      const height = Math.round(rect.height * dpr);
      if (width <= 0 || height <= 0) return;

      invoke("resize_embedded_poc", { x, y, width, height }).catch((err) => {
        console.warn("resize_embedded_poc error", err);
      });
    });
  }

  setupPocResizeObserver() {
    this.cleanupPocResizeObserver();
    const el = document.getElementById("poc-video-canvas");
    if (!el) return;
    if (typeof ResizeObserver !== "undefined") {
      this.pocResizeObserver = new ResizeObserver(() => {
        this.syncPocVideoBounds();
      });
      this.pocResizeObserver.observe(el);
      const parent = el.parentElement;
      if (parent) {
        this.pocResizeObserver.observe(parent);
      }
    }
  }

  cleanupPocResizeObserver() {
    if (this.pocResizeObserver) {
      this.pocResizeObserver.disconnect();
      this.pocResizeObserver = null;
    }
  }

  async stopEmbeddedPoc() {
    this.cleanupPocResizeObserver();
    try {
      await invoke("stop_embedded_poc");
    } catch (e) {
      console.warn("stop_embedded_poc error", e);
    }
    if (this.pocUnlisten) {
      this.pocUnlisten();
      this.pocUnlisten = null;
    }
    document.body.classList.remove("embedded-poc-active");
    this.pocActive = false;
    this.pocStatus = "Stopped";
    this.pocCurrentTime = 0;
    this.pocDuration = 0;
    this.cdr.detectChanges();
  }

  async togglePocPause() {
    try {
      await invoke("send_embedded_poc_ipc", {
        command: JSON.stringify({ command: ["cycle", "pause"] }),
      });
    } catch (err: any) {
      this.toastr.error(`IPC command error: ${err}`);
    }
  }

  onPocOverlayClick() {
    this.pocOverlayClicks++;
    this.toastr.info(`Overlay clicked! Count: ${this.pocOverlayClicks}`);
    this.togglePocPause();
  }

  ngOnDestroy(): void {
    this.cleanupPocResizeObserver();
    if (this.pocActive) {
      this.stopEmbeddedPoc();
    }
    this.subscriptions.forEach((x) => x.unsubscribe());
  }
}
