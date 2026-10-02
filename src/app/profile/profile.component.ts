import { Component, HostListener, OnInit } from "@angular/core";
import { Router } from "@angular/router";
import { invoke } from "@tauri-apps/api/core";
import { ToastrService } from "ngx-toastr";
import { MemoryService } from "../memory.service";
import { Channel } from "../models/channel";
import { Filters } from "../models/filters";
import { MediaType } from "../models/mediaType";
import { NavTab } from "../models/navTab";
import { SortType } from "../models/sortType";
import { ViewMode } from "../models/viewMode";

@Component({
  selector: "app-profile",
  templateUrl: "./profile.component.html",
  styleUrl: "./profile.component.css",
})
export class ProfileComponent implements OnInit {
  activeSection: "favorites" | "history" = "favorites";

  // Favorites state
  favoriteChannels: Channel[] = [];
  filteredFavorites: Channel[] = [];
  favSearchQuery: string = "";
  favMediaType: number = -1;
  loadingFavorites: boolean = false;

  // History state
  historyChannels: Channel[] = [];
  filteredHistory: Channel[] = [];
  historySearchQuery: string = "";
  historyMediaType: number = -1;
  loadingHistory: boolean = false;

  mediaTypeEnum = MediaType;
  viewModeEnum = ViewMode;

  constructor(
    private router: Router,
    public memory: MemoryService,
    private toastr: ToastrService,
  ) {}

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
      event.key === "Escape" ||
      event.key === "BrowserBack" ||
      (event.key === "Backspace" && !this.isInputFocused())
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
    this.loadFavorites();
    this.loadHistory();
  }

  setSection(section: "favorites" | "history") {
    this.activeSection = section;
    if (section === "favorites") {
      this.loadFavorites();
    } else {
      this.loadHistory();
    }
  }

  setFavMediaType(type: number) {
    this.favMediaType = type;
    this.filterFavorites();
  }

  filterFavorites() {
    let list = this.favoriteChannels;
    if (this.favMediaType !== -1) {
      list = list.filter((c) => c.media_type === this.favMediaType);
    }
    if (this.favSearchQuery && this.favSearchQuery.trim() !== "") {
      const q = this.favSearchQuery.toLowerCase().trim();
      list = list.filter((c) => (c.name || "").toLowerCase().includes(q));
    }
    this.filteredFavorites = list;
  }

  async loadFavorites() {
    this.loadingFavorites = true;
    try {
      const sources = (await invoke("get_sources")) as any[];
      const enabledSources = sources.filter((s) => s.enabled);
      if (enabledSources.length === 0) {
        this.favoriteChannels = [];
        this.filteredFavorites = [];
        this.loadingFavorites = false;
        return;
      }
      const sourceIds = enabledSources.map((s) => s.id);
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

  setHistoryMediaType(type: number) {
    this.historyMediaType = type;
    this.filterHistory();
  }

  filterHistory() {
    let list = this.historyChannels;
    if (this.historyMediaType !== -1) {
      list = list.filter((c) => c.media_type === this.historyMediaType);
    }
    if (this.historySearchQuery && this.historySearchQuery.trim() !== "") {
      const q = this.historySearchQuery.toLowerCase().trim();
      list = list.filter((c) => (c.name || "").toLowerCase().includes(q));
    }
    this.filteredHistory = list;
  }

  async loadHistory() {
    this.loadingHistory = true;
    try {
      const sources = (await invoke("get_sources")) as any[];
      const enabledSources = sources.filter((s) => s.enabled);
      if (enabledSources.length === 0) {
        this.historyChannels = [];
        this.filteredHistory = [];
        this.loadingHistory = false;
        return;
      }
      const sourceIds = enabledSources.map((s) => s.id);
      const filters: Filters = {
        source_ids: sourceIds,
        view_type: ViewMode.History,
        media_types: [MediaType.livestream, MediaType.movie, MediaType.serie],
        page: 1,
        use_keywords: false,
        sort: SortType.alphabeticalAscending,
      };
      let allHistory: Channel[] = [];
      let page = 1;
      let hasMore = true;
      while (hasMore && page <= 25) {
        filters.page = page;
        const res = (await invoke("search", { filters })) as Channel[];
        if (res && res.length > 0) {
          allHistory = allHistory.concat(res);
          hasMore = res.length === 36;
          page++;
        } else {
          hasMore = false;
        }
      }
      this.historyChannels = allHistory;
      this.filterHistory();
    } catch (e) {
      console.error("Failed to load history", e);
    }
    this.loadingHistory = false;
  }

  async clearHistory() {
    await this.memory.tryIPC(
      "History cleared successfully",
      "Failed to clear history",
      async () => {
        await invoke("clear_history");
        this.historyChannels = [];
        this.filteredHistory = [];
      }
    );
  }

  goBack() {
    this.memory.activeNavTab.next(NavTab.Home);
    this.router.navigateByUrl("");
  }
}
