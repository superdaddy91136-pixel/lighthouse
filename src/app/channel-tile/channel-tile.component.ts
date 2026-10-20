import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  Output,
  Renderer2,
  SimpleChanges,
  ViewChild,
} from "@angular/core";
import { MatMenuTrigger } from "@angular/material/menu";
import { Channel } from "../models/channel";
import { MemoryService } from "../memory.service";
import { MediaType } from "../models/mediaType";
import { invoke } from "@tauri-apps/api/core";
import { ToastrService } from "ngx-toastr";
import { ErrorService } from "../error.service";
import { NgbModal } from "@ng-bootstrap/ng-bootstrap";
import { EditChannelModalComponent } from "../edit-channel-modal/edit-channel-modal.component";
import { EditGroupModalComponent } from "../edit-group-modal/edit-group-modal.component";
import { DeleteGroupModalComponent } from "../delete-group-modal/delete-group-modal.component";
import { EpgModalComponent } from "../epg-modal/epg-modal.component";
import { EPG } from "../models/epg";
import { RestreamModalComponent } from "../restream-modal/restream-modal.component";
import { DownloadService } from "../download.service";
import { Download } from "../models/download";
import { Subscription, take } from "rxjs";
import { save } from "@tauri-apps/plugin-dialog";
import { CHANNEL_EXTENSION, GROUP_EXTENSION, RECORD_EXTENSION } from "../models/extensions";
import { getDateFormatted, getExtension, sanitizeFileName } from "../utils";
import { NodeType, fromMediaType } from "../models/nodeType";

import { ViewMode } from "../models/viewMode";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { MovieDetailService } from "../services/movie-detail.service";
import { TvDetailService } from "../services/tv-detail.service";
import { PinService } from "../services/pin.service";
import { EmbeddedPlayerService } from "../services/embedded-player.service";
import { NavTab } from "../models/navTab";
import { cleanMediaTitle } from "../utils/media-presentation";

@Component({
  selector: "app-channel-tile",
  templateUrl: "./channel-tile.component.html",
  styleUrl: "./channel-tile.component.css",
})
export class ChannelTileComponent implements OnInit, OnDestroy, AfterViewInit, OnChanges {
  constructor(
    public memory: MemoryService,
    private toastr: ToastrService,
    private error: ErrorService,
    private modal: NgbModal,
    private el: ElementRef,
    private renderer: Renderer2,
    private download: DownloadService,
    private movieDetailService: MovieDetailService,
    private tvDetailService: TvDetailService,
    public pinService: PinService,
    public embeddedPlayer: EmbeddedPlayerService,
  ) { }
  @Input() channel?: Channel;
  @Input() id!: number;
  @Input() viewMode: number = 0;
  @Input() isLiveTvCard?: boolean;
  @Output() unhidden = new EventEmitter<Channel>();
  @ViewChild(MatMenuTrigger, { static: true }) matMenuTrigger!: MatMenuTrigger;
  menuTopLeftPosition = { x: 0, y: 0 };
  showImage: boolean = true;
  starting: boolean = false;
  alreadyExistsInFav = false;
  alreadyHidden = false;
  downloading = false;
  mediaTypeEnum = MediaType;
  viewModeEnum = ViewMode;
  subscriptions: Subscription[] = [];
  fade = false;
  nowPlayingEpg?: EPG;
  static epgCache: Map<number, EPG | null> = new Map();
  static epgInFlight: Set<number> = new Set();

  ngOnInit(): void {
    if ((this.isLivestream() || this.isLiveTv()) && !this.isGroup() && this.showEPG()) {
      this.loadNowPlayingEPG();
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['channel'] && !changes['channel'].firstChange) {
      this.nowPlayingEpg = undefined;
      this.showImage = true;
      if ((this.isLivestream() || this.isLiveTv()) && !this.isGroup() && this.showEPG()) {
        this.loadNowPlayingEPG();
      }
    }
  }

  ngAfterViewInit(): void {
    this.getExistingDownload();
  }

  setDownloadGradient(progress: number) {
    let element = this.el.nativeElement.querySelector(`#tile-${this.id}`);
    let background = `linear-gradient(to right, green ${progress}%, #343a40 ${progress}%)`;
    this.renderer.setStyle(element, "background", background);
  }

  clearDownloadGradient() {
    let element = this.el.nativeElement.querySelector(`#tile-${this.id}`);
    let background = "#343a40";
    this.renderer.setStyle(element, "background", background);
  }

  async onPlayClick(event: MouseEvent): Promise<void> {
    event.stopPropagation();
    if (this.starting) return;
    if (this.isGroup()) {
      this.click();
      return;
    }
    if (this.channel) {
      this.starting = true;
      try {
        const canvas = this.embeddedPlayer.resolveVideoCanvasId();
        await this.embeddedPlayer.playMediaDirectly(this.channel, canvas);
      } finally {
        this.starting = false;
      }
    }
  }

  async click(record = false) {
    if (this.starting === true) {
      try {
        await invoke("cancel_play", { sourceId: this.channel?.source_id, channelId: this.channel?.id });
      } catch (e) {
        this.error.handleError(e);
      }
      return;
    }
    if (!record && this.channel?.media_type === MediaType.serie) {
      this.tvDetailService.openTvDetail(this.channel);
      return;
    }
    if (
      this.channel?.media_type == MediaType.group ||
      this.channel?.media_type == MediaType.season
    ) {
      this.memory.SetNode.next({
        id: this.channel.id!,
        name: this.channel.name!,
        type: fromMediaType(this.channel.media_type),
        sourceId: this.channel.source_id,
      });
      return;
    }
    const isEpisode = !!(this.channel?.season_id != null || this.channel?.episode_num != null);
    if (!record && this.channel?.media_type === MediaType.movie && !isEpisode) {
      this.movieDetailService.openMovieDetail(this.channel);
      return;
    }
    let file = undefined;
    if (record && (this.memory.IsContainer || this.memory.AlwaysAskSave)) {
      file = await save({
        canCreateDirectories: true,
        title: "Select where to save recording",
        defaultPath: `${sanitizeFileName(this.channel?.name!)}_${getDateFormatted()}${RECORD_EXTENSION}`,
      });
      if (!file) return;
    }
    this.starting = true;
    this.memory.SetFocus.next(this.id);
    const playChannel = {
      ...this.channel,
      media_type: this.channel?.media_type,
      favorite: !!this.channel?.favorite,
    };
    invoke("add_last_watched", { id: this.channel?.id }).catch((e) => {
      console.error(e);
      this.error.handleError(e);
    });

    if (!record && (this.channel?.media_type === MediaType.livestream || this.isLiveTv())) {
      try {
        const canvas = this.embeddedPlayer.resolveVideoCanvasId();
        await this.embeddedPlayer.startPlayer(playChannel, canvas, {
          title: cleanMediaTitle(this.channel?.name || 'Live TV'),
          mode: 'live',
        });
      } catch (err) {
        console.warn('Failed to start embedded live player:', err);
        this.error.handleError(err);
      }
      this.starting = false;
      return;
    }

    if (!record) {
      try {
        const mode = isEpisode ? 'episode' : 'movie';
        const canvas = this.embeddedPlayer.resolveVideoCanvasId();
        await this.embeddedPlayer.startPlayer(playChannel, canvas, {
          title: cleanMediaTitle(this.channel?.name || (isEpisode ? 'Episode' : 'Video')),
          mode,
        });
      } catch (err) {
        console.warn('Failed to start embedded player:', err);
        this.error.handleError(err);
      }
      this.starting = false;
      return;
    }

    try {
      await invoke("play", { channel: playChannel, record: true, recordPath: file });
    } catch (e) {
      this.error.handleError(e);
    }
    this.starting = false;
  }

  onRightClick(event: MouseEvent) {
    if (this.channel?.media_type == MediaType.season) return;
    this.alreadyExistsInFav = this.channel!.favorite!;
    this.alreadyHidden = this.channel!.hidden!;
    this.downloading = this.isDownloading();
    event.preventDefault();
    this.menuTopLeftPosition.x = event.clientX;
    this.menuTopLeftPosition.y = event.clientY;
    if (this.memory.currentContextMenu?.menuOpen) this.memory.currentContextMenu.closeMenu();
    this.memory.currentContextMenu = this.matMenuTrigger;
    this.matMenuTrigger.openMenu();
  }

  isPinned(): boolean {
    if (!this.channel) return false;
    return this.pinService.isPinned(this.channel, this.memory.activeNavTab.value);
  }

  canPin(): boolean {
    if (!this.channel || this.channel.media_type === MediaType.season) return false;
    const tab = this.memory.activeNavTab.value;
    return (
      tab === NavTab.LiveTV ||
      tab === NavTab.Movies ||
      tab === NavTab.TVShows ||
      this.channel.media_type === MediaType.livestream ||
      this.channel.media_type === MediaType.movie ||
      this.channel.media_type === MediaType.serie ||
      this.channel.media_type === MediaType.group
    );
  }

  togglePin(): void {
    if (!this.channel) return;
    const tab = this.pinService.getTabForChannel(this.channel, this.memory.activeNavTab.value);
    const wasPinned = this.isPinned();
    this.pinService.togglePin(this.channel, tab);
    const name = cleanMediaTitle(this.channel.name || '');
    if (wasPinned) {
      this.toastr.success(`Unpinned "${name}"`);
    } else {
      this.toastr.success(`Pinned "${name}"`);
    }
  }

  onError(event: Event) {
    this.showImage = false;
  }

  async favorite() {
    let call = "favorite_channel";
    const wasFavorite = this.channel!.favorite;
    if (wasFavorite) {
      call = "unfavorite_channel";
    }
    try {
      await invoke(call, { channelId: this.channel!.id });
      this.channel!.favorite = !wasFavorite;
      if (this.viewMode == ViewMode.Favorites) {
        this.fade = !!wasFavorite;
      }
    } catch (e) {
      this.error.handleError(e, `Failed to add/remove "${this.channel?.name}" to/from favorites`);
    }
  }

  async removeFromHistory() {
    try {
      await invoke("remove_from_history", { id: this.channel!.id });
      this.memory.Refresh.next(false);
      this.toastr.success(`Removed "${this.channel?.name}" from history`);
    } catch (e) {
      this.error.handleError(e, `Failed to remove "${this.channel?.name}" from history`);
    }
  }

  async unhideItem(event?: MouseEvent) {
    if (event) {
      event.stopPropagation();
      event.preventDefault();
    }
    const isGroup = this.channel?.media_type === MediaType.group;
    const command = isGroup ? "hide_group" : "hide_channel";
    const args = { id: this.channel!.id, hidden: false };

    try {
      await invoke(command, args);
      this.channel!.hidden = false;
      this.unhidden.emit(this.channel!);
      this.toastr.success(`Unhidden "${this.channel?.name}"`);
    } catch (e) {
      this.error.handleError(e, `Failed to unhide "${this.channel?.name}"`);
    }
  }

  async hide() {
    const isGroup = this.channel?.media_type === MediaType.group;
    const hide = !this.channel!.hidden;

    const command = isGroup ? "hide_group" : "hide_channel";
    const args = { id: this.channel!.id, hidden: hide };

    const action = hide ? "Hidden" : "Unhidden";
    const type = isGroup ? "group " : "";
    const msg = `${action} ${type}"${this.channel?.name}"`;

    try {
      await invoke(command, args);
      this.channel!.hidden = hide;
      if (this.viewMode == ViewMode.Hidden && !hide) {
        this.unhidden.emit(this.channel!);
      }
      this.fade = this.viewMode == ViewMode.Hidden ? !hide : hide;
      this.toastr.success(`${msg} (updates on reload)`);
    } catch (e) {
      this.error.handleError(e, `Failed to hide/unhide "${this.channel?.name}"`);
    }
  }

  async record() {
    await this.click(true);
  }

  isMovie() {
    return this.channel?.media_type == MediaType.movie;
  }

  isLivestream() {
    return this.channel?.media_type == MediaType.livestream;
  }

  isGroup(): boolean {
    return this.channel?.media_type == MediaType.group;
  }

  isTvShow(): boolean {
    return this.channel?.media_type === MediaType.serie;
  }

  isLiveTv(): boolean {
    return !!this.isLiveTvCard || this.memory.activeNavTab.value === NavTab.LiveTV;
  }

  isCardMode(): boolean {
    const tab = this.memory.activeNavTab.value;
    if (tab === NavTab.Settings) {
      return false;
    }
    return true;
  }

  async loadNowPlayingEPG() {
    if (!this.channel?.id || !this.showEPG()) return;
    const cacheKey = this.channel.id;
    if (ChannelTileComponent.epgCache.has(cacheKey)) {
      this.nowPlayingEpg = ChannelTileComponent.epgCache.get(cacheKey) || undefined;
      return;
    }
    if (ChannelTileComponent.epgInFlight.has(cacheKey)) return;
    ChannelTileComponent.epgInFlight.add(cacheKey);

    try {
      const data: EPG[] = await invoke("get_epg", { channel: this.channel });
      if (data && data.length > 0) {
        const now = Math.floor(Date.now() / 1000);
        const current = data.find((p) => p.now_playing) ||
                        data.find((p) => p.start_timestamp <= now) ||
                        data[0];
        ChannelTileComponent.epgCache.set(cacheKey, current || null);
        this.nowPlayingEpg = current;
      } else {
        ChannelTileComponent.epgCache.set(cacheKey, null);
      }
    } catch {
      ChannelTileComponent.epgCache.set(cacheKey, null);
    } finally {
      ChannelTileComponent.epgInFlight.delete(cacheKey);
    }
  }

  getEpgTimeDisplay(): string {
    if (!this.nowPlayingEpg) return '';
    if (this.nowPlayingEpg.start_time && this.nowPlayingEpg.end_time) {
      const start = this.extractTimeOnly(this.nowPlayingEpg.start_time);
      const end = this.extractTimeOnly(this.nowPlayingEpg.end_time);
      return `${start} – ${end}`;
    }
    if (this.nowPlayingEpg.start_time) {
      return this.extractTimeOnly(this.nowPlayingEpg.start_time);
    }
    return '';
  }

  private extractTimeOnly(timeStr: string): string {
    if (!timeStr) return '';
    if (timeStr.includes(',')) {
      const parts = timeStr.split(',');
      return parts[parts.length - 1].trim();
    }
    return timeStr.trim();
  }

  getEpgProgress(): number {
    if (!this.nowPlayingEpg?.start_timestamp) return 0;
    const nowSec = Math.floor(Date.now() / 1000);
    const start = this.nowPlayingEpg.start_timestamp;
    if (nowSec <= start) return 0;
    const defaultEnd = start + 3600;
    const elapsed = nowSec - start;
    const total = defaultEnd - start;
    return Math.min(100, Math.max(5, Math.round((elapsed / total) * 100)));
  }

  getCleanTitle(): string {
    return cleanMediaTitle(this.channel?.name || '');
  }

  toggleFavorite(event: MouseEvent) {
    event.stopPropagation();
    this.favorite();
  }

  isCustom(): boolean {
    return this.memory.CustomSourceIds!.has(this.channel?.source_id!);
  }

  showEPG(): boolean {
    return (
      (this.channel?.media_type == MediaType.livestream || (this.isLiveTv() && !this.isGroup())) &&
      !this.isCustom() &&
      this.memory.XtreamSourceIds.has(this.channel?.source_id!)
    );
  }

  getSourceName(): string {
    if (!this.channel?.source_id) return "";
    return this.memory.Sources.get(this.channel.source_id)?.name || "";
  }

  async showEPGModal() {
    try {
      let data: EPG[] = await invoke("get_epg", { channel: this.channel });
      if (data.length == 0) {
        this.toastr.info("No EPG data for this channel");
        return;
      }
      this.memory.ModalRef = this.modal.open(EpgModalComponent, {
        backdrop: "static",
        size: "xl",
        keyboard: false,
      });
      this.memory.ModalRef.result.then((_) => (this.memory.ModalRef = undefined));
      this.memory.ModalRef.componentInstance.epg = data;
      this.memory.ModalRef.componentInstance.name = this.channel?.name;
      this.memory.ModalRef.componentInstance.channelId = this.channel?.id;
      this.memory.ModalRef.componentInstance.sourceId = this.channel?.source_id;
    } catch (e) {
      this.error.handleError(
        e,
        "Missing stream id. Please refresh your sources (Settings -> Refresh All) to enable the EPG feature",
      );
    }
  }

  edit() {
    if (this.channel?.media_type == MediaType.group) this.edit_group();
    else {
      this.edit_channel();
    }
  }

  edit_group() {
    this.memory.ModalRef = this.modal.open(EditGroupModalComponent, {
      backdrop: "static",
      size: "xl",
      keyboard: false,
    });
    this.memory.ModalRef.result.then((_) => (this.memory.ModalRef = undefined));
    this.memory.ModalRef.componentInstance.name = "EditCustomGroupModal";
    this.memory.ModalRef.componentInstance.editing = true;
    this.memory.ModalRef.componentInstance.group = {
      id: this.channel!.id,
      name: this.channel!.name,
      image: this.channel!.image,
      source_id: this.channel!.source_id,
    };
    this.memory.ModalRef.componentInstance.originalName = this.channel!.name;
  }

  edit_channel() {
    this.memory.ModalRef = this.modal.open(EditChannelModalComponent, {
      backdrop: "static",
      size: "xl",
      keyboard: false,
    });
    this.memory.ModalRef.result.then((_) => (this.memory.ModalRef = undefined));
    this.memory.ModalRef.componentInstance.name = "EditCustomChannelModal";
    this.memory.ModalRef.componentInstance.editing = true;
    this.memory.ModalRef.componentInstance.channel.data = { ...this.channel };
  }

  async share() {
    let entityName = this.channel?.media_type == MediaType.group ? "group" : "channel";
    let file = await save({
      canCreateDirectories: true,
      title: `Select where to export ${entityName}`,
      defaultPath:
        sanitizeFileName(this.channel?.name!) +
        (this.channel?.media_type == MediaType.group ? GROUP_EXTENSION : CHANNEL_EXTENSION),
    });
    if (!file) {
      return;
    }
    if (this.channel?.media_type == MediaType.group) {
      this.memory.tryIPC(
        `Successfully exported category to ${file}`,
        "Failed to export channel",
        () => invoke("share_custom_group", { group: this.channel, path: file }),
      );
    } else {
      this.memory.tryIPC(
        `Successfully exported channel to ${file}`,
        "Failed to export channel",
        () => invoke("share_custom_channel", { channel: this.channel, path: file }),
      );
    }
  }

  async delete() {
    if (this.channel?.media_type == MediaType.group) this.deleteGroup();
    else await this.deleteChannel();
  }

  async deleteGroup() {
    try {
      if (await invoke("group_not_empty", { id: this.channel?.id })) {
        this.openDeleteGroupModal();
      } else await this.deleteGroupNoReplace();
    } catch (e) {
      this.error.handleError(e);
    }
  }

  async deleteGroupNoReplace() {
    try {
      await invoke("delete_custom_group", {
        id: this.channel?.id,
        doChannelsUpdate: false,
      });
      this.memory.Refresh.next(true);
      this.error.success("Successfully deleted category");
    } catch (e) {
      this.error.handleError(e);
    }
  }

  openDeleteGroupModal() {
    this.memory.ModalRef = this.modal.open(DeleteGroupModalComponent, {
      backdrop: "static",
      size: "xl",
      keyboard: false,
    });
    this.memory.ModalRef.result.then((_) => (this.memory.ModalRef = undefined));
    this.memory.ModalRef.componentInstance.name = "DeleteGroupModal";
    this.memory.ModalRef.componentInstance.group = { ...this.channel };
  }

  openRestreamModal() {
    this.memory.ModalRef = this.modal.open(RestreamModalComponent, {
      backdrop: "static",
      size: "xl",
      keyboard: false,
    });
    this.memory.ModalRef.componentInstance.channel = this.channel;
    this.memory.ModalRef.componentInstance.name = "RestreamModalComponent";
    this.memory.ModalRef.result.then((_) => (this.memory.ModalRef = undefined));
  }

  async deleteChannel() {
    await this.memory.tryIPC("Successfully deleted channel", "Failed to delete channel", () =>
      invoke("delete_custom_channel", { id: this.channel?.id }),
    );
    this.memory.Refresh.next(true);
  }

  isDownloading() {
    return this.download.Downloads.has(this.channel!.id!.toString());
  }

  async downloadVod() {
    let file = undefined;
    if (this.memory.IsContainer || this.memory.AlwaysAskSave) {
      file = await save({
        canCreateDirectories: true,
        title: "Select where to download movie",
        defaultPath: `${sanitizeFileName(this.channel?.name!)}.${getExtension(this.channel?.url!)}`,
      });
      if (!file) {
        return;
      }
    }
    let download = await this.download.addDownload(
      this.channel!.id!.toString(),
      this.channel!,
    );
    this.downloadSubscribe(download);
    await this.download.download(download.id, file);
  }

  async cancelDownload() {
    await this.download.abortDownload(this.channel!.id!.toString());
  }

  getExistingDownload() {
    let download = this.download.Downloads.get(this.channel!.id!.toString());
    if (download) {
      this.setDownloadGradient(download.progress);
      this.downloadSubscribe(download);
    }
  }

  downloadSubscribe(download: Download) {
    let progressUpdate = download.progressUpdate.subscribe((progress) => {
      this.setDownloadGradient(progress);
      if (progress == 100) progressUpdate.unsubscribe();
    });
    this.subscriptions.push(progressUpdate);
    this.subscriptions.push(
      download.complete.pipe(take(1)).subscribe((_) => {
        progressUpdate.unsubscribe();
        this.clearDownloadGradient();
      }),
    );
  }

  async copyURL() {
    try {
      await writeText(this.channel?.url ?? "");
      this.error.success("Copied channel URL");
    }
    catch (e) {
      this.error.handleError(e);
    }
  }

  ngOnDestroy() {
    this.subscriptions.forEach((x) => x.unsubscribe());
  }
}
