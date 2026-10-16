import { Injectable, NgZone, OnDestroy } from '@angular/core';
import { Router, NavigationStart } from '@angular/router';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen, UnlistenFn } from '@tauri-apps/api/event';
import { ToastrService } from 'ngx-toastr';
import { BehaviorSubject, Observable, Subject, Subscription } from 'rxjs';
import { filter } from 'rxjs/operators';
import { Channel } from '../models/channel';
import { MediaType } from '../models/mediaType';
import { ViewMode } from '../models/viewMode';
import { SortType } from '../models/sortType';
import { MemoryService } from '../memory.service';
import { cleanMediaTitle } from '../utils/media-presentation';
import { isInputFocused } from '../utils';

export type ContentMode = 'movie' | 'episode' | 'live';

export interface SwitcherEpisodeData {
  id: number;
  channel: Channel;
  episodeNum: number;
  seasonNum: number;
  title: string;
  stillUrl?: string;
  isWatched?: boolean;
  isCurrent?: boolean;
}

export interface SwitcherSeasonData {
  id: number;
  seasonNum: number;
  name: string;
}

export interface SwitcherChannelData {
  id: number;
  name: string;
  logo?: string;
  group?: string;
  group_id?: number;
  isCurrent?: boolean;
  channel?: Channel;
}

export interface EmbeddedPlayerOptions {
  title?: string;
  mode?: ContentMode;
  startTime?: number;
  // TV Episode switcher options
  seriesChannel?: Channel;
  seriesTitle?: string;
  seasons?: SwitcherSeasonData[];
  currentSeasonNum?: number;
  episodes?: SwitcherEpisodeData[];
  onSwitchEpisode?: (channel: Channel) => void | Promise<void>;
  // Live TV channel switcher options
  channels?: (Channel | SwitcherChannelData)[];
  currentGroupId?: number;
  onSwitchChannel?: (channel: Channel) => void | Promise<void>;
}

@Injectable({
  providedIn: 'root',
})
export class EmbeddedPlayerService implements OnDestroy {
  private isPlayingEmbeddedSubject = new BehaviorSubject<boolean>(false);
  public isPlayingEmbedded$: Observable<boolean> = this.isPlayingEmbeddedSubject.asObservable();

  private isFullscreenSubject = new BehaviorSubject<boolean>(false);
  public isFullscreen$: Observable<boolean> = this.isFullscreenSubject.asObservable();
  public lastWatchedUpdated$ = new Subject<number>();

  public get isPlayingEmbedded(): boolean {
    return this.isPlayingEmbeddedSubject.value;
  }

  public get isFullscreen(): boolean {
    return this.isFullscreenSubject.value;
  }

  private currentMode: ContentMode = 'movie';
  public get mode(): ContentMode {
    return this.currentMode;
  }

  private hostTarget: HTMLElement | string | null = null;
  private currentChannel?: Channel;
  private activeFallbackChannel?: Channel;
  private videoResizeObserver: ResizeObserver | null = null;
  private syncScheduled: boolean = false;
  private boundScrollHandler = () => this.syncBounds();
  private boundKeyDownHandler = (e: KeyboardEvent) => this.handleKeyDown(e);
  private keyHandlerAttached: boolean = false;
  private isRestartingPlayer: boolean = false;

  // TV Episode switcher state
  private seriesChannel?: Channel;
  private seriesTitle?: string;
  private seasons: SwitcherSeasonData[] = [];
  private currentSeasonNum: number = 1;
  private episodes: SwitcherEpisodeData[] = [];
  private onSwitchEpisodeCallback?: (channel: Channel) => void | Promise<void>;

  // Live TV switcher state
  private liveChannels: SwitcherChannelData[] = [];
  private currentGroupId?: number;
  private onSwitchChannelCallback?: (channel: Channel) => void | Promise<void>;

  private unlistenStopped?: UnlistenFn;
  private unlistenFullscreen?: UnlistenFn;
  private unlistenSyncBounds?: UnlistenFn;
  private unlistenAspect?: UnlistenFn;
  private unlistenPlayerStarted?: UnlistenFn;
  private unlistenRequestMode?: UnlistenFn;
  private unlistenRequestCrop?: UnlistenFn;
  private unlistenGlobalStopped?: UnlistenFn;

  private unlistenRequestEpisodes?: UnlistenFn;
  private unlistenChangeSeason?: UnlistenFn;
  private unlistenSelectEpisode?: UnlistenFn;
  private unlistenRequestChannels?: UnlistenFn;
  private unlistenSelectChannel?: UnlistenFn;
  private unlistenSaveProgress?: UnlistenFn;

  private routerSubscription?: Subscription;

  private savedScrollTop: number = 0;
  private savedMainScrollTop: number = 0;

  constructor(
    private ngZone: NgZone,
    private toastr: ToastrService,
    private router: Router,
    private memory: MemoryService,
  ) {
    this.initGlobalListeners();
    this.routerSubscription = this.router.events
      .pipe(filter((event) => event instanceof NavigationStart))
      .subscribe(() => {
        if (this.isPlayingEmbedded) {
          this.stopPlayer().catch(console.warn);
        }
      });
  }

  private async initGlobalListeners(): Promise<void> {
    // Listen for stream started (captures stream info even if started outside service, e.g. movie screen)
    this.unlistenPlayerStarted = await listen('embedded-player-started', (event: any) => {
      this.ngZone.run(() => {
        const stream = event?.payload;
        if (stream?.channel_id && stream?.url) {
          this.activeFallbackChannel = {
            id: stream.channel_id,
            name: stream.name,
            url: stream.url,
            source_id: stream.source_id,
            media_type: MediaType.movie,
          };
          if (!this.isPlayingEmbedded) {
            this.currentMode = 'movie';
            emit('embedded-player-mode', { mode: 'movie' }).catch(console.warn);
          }
        }
      });
    });

    // Listen for mode request from overlay (on late-load or restart)
    this.unlistenRequestMode = await listen('request-player-mode', () => {
      emit('embedded-player-mode', { mode: this.currentMode, channelId: this.currentChannel?.id }).catch(console.warn);
    });

    // Listen for top-crop request from overlay
    this.unlistenRequestCrop = await listen('request-overlay-top-crop', () => {
      const crop = this.isPlayingEmbedded ? 32 : 0;
      emit('overlay-top-crop', { crop }).catch(console.warn);
    });

    // Global listener for player stopped (catches exits/crashes cleanly without black screen)
    this.unlistenGlobalStopped = await listen('embedded-poc-stopped', () => {
      this.ngZone.run(() => {
        if (this.isPlayingEmbedded) {
          this.handlePlayerStopped();
        }
      });
    });

    // Listen for episodes request from overlay
    this.unlistenRequestEpisodes = await listen('request-player-episodes', async () => {
      if (this.currentMode === 'episode') {
        if (this.episodes.length === 0) {
          if (this.seasons.length === 0 && this.currentChannel) {
            await this.loadSeriesAndSeasons(this.currentChannel, this.currentSeasonNum);
          } else if (this.seasons.length > 0) {
            const targetSeason = this.seasons.find((s) => s.seasonNum === this.currentSeasonNum) || this.seasons[0];
            if (targetSeason) {
              await this.loadEpisodesForSeason(targetSeason.id, targetSeason.seasonNum);
            }
          }
        }
      }
      this.emitEpisodesData();
    });

    // Listen for season change request from overlay
    this.unlistenChangeSeason = await listen('request-change-season', (event: any) => {
      const payload = event?.payload;
      if (payload?.seasonId) {
        this.loadEpisodesForSeason(payload.seasonId, payload.seasonNum || 1);
      }
    });

    // Listen for episode selection from overlay
    this.unlistenSelectEpisode = await listen('select-player-episode', (event: any) => {
      const episodeId = event?.payload?.episodeId ?? event?.payload?.id;
      let targetEp = this.episodes.find((e) => e.id === episodeId);
      const targetChannel: Channel | undefined = targetEp?.channel || event?.payload?.channel;
      const chId = targetChannel?.id || episodeId;

      if (chId) {
        invoke('add_last_watched', { id: chId }).catch(console.warn);
        this.lastWatchedUpdated$.next(chId);
      }

      if (!targetEp && targetChannel) {
        const epNum = targetChannel.episode_num || this.extractEpisodeNumber(targetChannel.name);
        const sNum = this.extractSeasonNumber(targetChannel);
        targetEp = {
          id: targetChannel.id!,
          channel: targetChannel,
          episodeNum: epNum,
          seasonNum: sNum,
          title: cleanMediaTitle(targetChannel.name || `Episode ${epNum}`),
          stillUrl: targetChannel.image,
          isWatched: true,
          isCurrent: true,
        };
      }

      if (targetEp) {
        targetEp.isWatched = true;
        (targetEp.channel as any).last_watched = Date.now();
        this.currentSeasonNum = targetEp.seasonNum;
        this.emitEpisodesData();

        this.ngZone.run(() => {
          if (this.onSwitchEpisodeCallback) {
            this.onSwitchEpisodeCallback(targetEp!.channel);
          } else {
            const seriesName = this.seriesTitle || this.extractSeriesTitle(targetEp!.channel) || '';
            const sNum = String(targetEp!.seasonNum).padStart(2, '0');
            const eNum = String(targetEp!.episodeNum).padStart(2, '0');
            const overlayTitle = seriesName
              ? `${seriesName} - S${sNum}E${eNum}: ${targetEp!.title}`.trim()
              : `S${sNum}E${eNum}: ${targetEp!.title}`.trim();
            this.startPlayer(targetEp!.channel, this.hostTarget || 'home-video-canvas', {
              mode: 'episode',
              title: overlayTitle,
              seriesChannel: this.seriesChannel,
              seriesTitle: this.seriesTitle || seriesName,
              seasons: this.seasons,
              currentSeasonNum: targetEp!.seasonNum,
              episodes: this.episodes,
            });
          }
        });
      }
    });

    // Listen for live channels request from overlay
    this.unlistenRequestChannels = await listen('request-player-channels', async () => {
      if (this.liveChannels.length === 0) {
        await this.loadLiveChannels();
      } else {
        this.emitChannelsData();
      }
    });

    // Listen for channel selection from overlay
    this.unlistenSelectChannel = await listen('select-player-channel', (event: any) => {
      const channelId = event?.payload?.channelId ?? event?.payload?.id;
      let targetCh: Channel | undefined = event?.payload?.channel;
      if (!targetCh || !targetCh.url) {
        const found = this.liveChannels.find((c) => c.id === channelId);
        targetCh = found?.channel;
      }
      if (!targetCh && channelId != null) {
        targetCh = { id: channelId, name: event?.payload?.name || 'Live Channel' } as Channel;
      }
      if (targetCh) {
        if (event?.payload?.channel?.group_id != null) {
          targetCh.group_id = event.payload.channel.group_id;
          this.currentGroupId = event.payload.channel.group_id;
        }
        this.ngZone.run(() => {
          this.switchChannel(targetCh!);
        });
      }
    });

    // Listen for playback progress save requests from overlay
    this.unlistenSaveProgress = await listen('save-playback-progress', (event: any) => {
      const payload = event?.payload;
      if (payload?.channelId != null && payload?.time > 0) {
        this.saveWatchProgress(payload.channelId, payload.time, payload.duration || 0);
      }
    });
  }

  private getHostElement(): HTMLElement | null {
    if (!this.hostTarget) return null;
    if (typeof this.hostTarget === 'string') {
      return document.getElementById(this.hostTarget);
    }
    return this.hostTarget;
  }

  private saveScrollPosition(): void {
    try {
      this.savedScrollTop =
        window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
    } catch {
      this.savedScrollTop = 0;
    }
    const main = document.querySelector('.app-main');
    this.savedMainScrollTop = main ? main.scrollTop : 0;
  }

  private restoreScrollPosition(): void {
    setTimeout(() => {
      try {
        window.scrollTo({ top: this.savedScrollTop, behavior: 'instant' as ScrollBehavior });
      } catch {
        window.scrollTo(0, this.savedScrollTop);
      }
      const main = document.querySelector('.app-main');
      if (main) {
        main.scrollTop = this.savedMainScrollTop;
      }
    }, 20);
  }

  private async setupTauriListeners(): Promise<void> {
    this.cleanupTauriListeners();

    this.unlistenStopped = await listen('embedded-poc-stopped', () => {
      this.ngZone.run(() => {
        this.handlePlayerStopped();
      });
    });

    this.unlistenFullscreen = await listen('player-fullscreen-changed', (event: any) => {
      this.ngZone.run(() => {
        this.applyFullscreenState(!!event.payload);
      });
    });

    this.unlistenSyncBounds = await listen('sync-video-bounds', () => {
      this.ngZone.run(() => {
        this.syncBounds();
      });
    });

    this.unlistenAspect = await listen('video-aspect-changed', (_event: any) => {
      // Theater mode fills the whole content area; MPV letterboxes automatically.
    });
  }

  private cleanupTauriListeners(): void {
    if (this.unlistenStopped) {
      this.unlistenStopped();
      this.unlistenStopped = undefined;
    }
    if (this.unlistenFullscreen) {
      this.unlistenFullscreen();
      this.unlistenFullscreen = undefined;
    }
    if (this.unlistenSyncBounds) {
      this.unlistenSyncBounds();
      this.unlistenSyncBounds = undefined;
    }
    if (this.unlistenAspect) {
      this.unlistenAspect();
      this.unlistenAspect = undefined;
    }
  }

  private attachKeyHandler(): void {
    if (!this.keyHandlerAttached) {
      window.addEventListener('keydown', this.boundKeyDownHandler, true);
      this.keyHandlerAttached = true;
    }
  }

  private removeKeyHandler(): void {
    if (this.keyHandlerAttached) {
      window.removeEventListener('keydown', this.boundKeyDownHandler, true);
      this.keyHandlerAttached = false;
    }
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (!this.isPlayingEmbedded) return;

    if (
      event.key === 'Escape' ||
      event.key === 'BrowserBack' ||
      (event.key === 'Backspace' && !isInputFocused())
    ) {
      if (this.isFullscreen) {
        invoke('toggle_player_fullscreen').catch(console.error);
      } else {
        this.stopPlayer();
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (event.key === ' ' || event.code === 'Space') {
      invoke('send_embedded_poc_ipc', {
        command: JSON.stringify({ command: ['cycle', 'pause'] }),
      }).catch(console.warn);
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (event.key === 'ArrowLeft') {
      if (this.currentMode !== 'live') {
        invoke('send_embedded_poc_ipc', {
          command: JSON.stringify({ command: ['seek', -10, 'relative'] }),
        }).catch(console.warn);
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (event.key === 'ArrowRight') {
      if (this.currentMode !== 'live') {
        invoke('send_embedded_poc_ipc', {
          command: JSON.stringify({ command: ['seek', 10, 'relative'] }),
        }).catch(console.warn);
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (event.key === 'ArrowUp' || event.key === 'AudioVolumeUp') {
      emit('player-volume-up').catch(console.warn);
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (event.key === 'ArrowDown' || event.key === 'AudioVolumeDown') {
      emit('player-volume-down').catch(console.warn);
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (event.key === 'f' || event.key === 'F') {
      invoke('toggle_player_fullscreen').catch(console.error);
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (event.key === 'm' || event.key === 'M' || event.key === 'AudioVolumeMute') {
      emit('player-volume-mute').catch(console.warn);
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (
      (event.key === 'i' || event.key === 'I') &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      !isInputFocused()
    ) {
      emit('toggle-nerd-stats').catch(console.warn);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
  }

  public syncBounds(immediate: boolean = false): void {
    if (!this.isPlayingEmbedded || this.isFullscreen) return;

    const doSync = () => {
      this.syncScheduled = false;
      if (!this.isPlayingEmbedded || this.isFullscreen) return;

      const el = this.getHostElement();
      if (!el) return;

      const rect = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const x = Math.round(rect.x * dpr);
      const y = Math.round(rect.y * dpr);
      const width = Math.round(rect.width * dpr);
      const height = Math.round(rect.height * dpr);
      if (width <= 0 || height <= 0) return;

      invoke('resize_embedded_poc', { x, y, width, height }).catch((err) => {
        console.warn('resize_embedded_poc error', err);
      });
    };

    if (immediate) {
      doSync();
      return;
    }

    if (this.syncScheduled) return;
    this.syncScheduled = true;
    requestAnimationFrame(doSync);
  }

  private setupVideoResizeObserver(): void {
    this.cleanupVideoResizeObserver();
    const el = this.getHostElement();
    if (!el) return;

    if (typeof ResizeObserver !== 'undefined') {
      this.videoResizeObserver = new ResizeObserver(() => {
        this.syncBounds();
      });
      this.videoResizeObserver.observe(el);
      const parent = el.parentElement;
      if (parent) {
        this.videoResizeObserver.observe(parent);
      }
    }

    const appMain = document.querySelector('.app-main');
    if (appMain) {
      appMain.addEventListener('scroll', this.boundScrollHandler, { passive: true });
    }
    window.addEventListener('scroll', this.boundScrollHandler, { passive: true });
    window.addEventListener('resize', this.boundScrollHandler, { passive: true });
  }

  private cleanupVideoResizeObserver(): void {
    if (this.videoResizeObserver) {
      this.videoResizeObserver.disconnect();
      this.videoResizeObserver = null;
    }
    const appMain = document.querySelector('.app-main');
    if (appMain) {
      appMain.removeEventListener('scroll', this.boundScrollHandler);
    }
    window.removeEventListener('scroll', this.boundScrollHandler);
    window.removeEventListener('resize', this.boundScrollHandler);
  }

  private applyFullscreenState(isFs: boolean): void {
    this.isFullscreenSubject.next(isFs);
    emit('overlay-top-crop', { crop: 32 }).catch(console.warn);
    if (isFs) {
      document.body.classList.add('fullscreen-player-active');
    } else {
      document.body.classList.remove('fullscreen-player-active');
      setTimeout(() => this.syncBounds(true), 50);
    }
  }

  public async toggleFullscreen(): Promise<void> {
    if (!this.isPlayingEmbedded) return;
    try {
      await invoke('toggle_player_fullscreen');
    } catch (e) {
      console.warn('Failed to toggle fullscreen:', e);
    }
  }

  private handlePlayerStopped(): void {
    if (this.isRestartingPlayer) {
      return;
    }
    this.cleanupVideoResizeObserver();
    this.removeKeyHandler();
    this.cleanupTauriListeners();

    this.currentMode = 'movie';
    emit('embedded-player-mode', { mode: 'movie' }).catch(console.warn);
    emit('overlay-top-crop', { crop: 0 }).catch(console.warn);

    this.currentChannel = undefined;
    this.activeFallbackChannel = undefined;
    this.seriesChannel = undefined;
    this.seriesTitle = undefined;
    this.seasons = [];
    this.episodes = [];
    this.onSwitchEpisodeCallback = undefined;
    this.liveChannels = [];
    this.onSwitchChannelCallback = undefined;

    if (this.isFullscreen) {
      this.isFullscreenSubject.next(false);
    }
    document.body.classList.remove('theater-mode-active');
    document.body.classList.remove('fullscreen-player-active');

    this.isPlayingEmbeddedSubject.next(false);
    this.restoreScrollPosition();
  }

  public async stopPlayer(): Promise<void> {
    this.cleanupVideoResizeObserver();
    this.removeKeyHandler();
    this.cleanupTauriListeners();

    this.currentMode = 'movie';
    emit('embedded-player-mode', { mode: 'movie' }).catch(console.warn);
    emit('overlay-top-crop', { crop: 0 }).catch(console.warn);

    if (this.isFullscreen) {
      this.isFullscreenSubject.next(false);
      document.body.classList.remove('fullscreen-player-active');
      try {
        await invoke('set_main_window_fullscreen', { fullscreen: false });
      } catch {}
    }

    document.body.classList.remove('theater-mode-active');
    document.body.classList.remove('fullscreen-player-active');

    try {
      await invoke('stop_embedded_poc');
    } catch (e) {
      console.warn('stop_embedded_poc error', e);
    }

    this.currentChannel = undefined;
    this.activeFallbackChannel = undefined;
    this.seriesChannel = undefined;
    this.seriesTitle = undefined;
    this.seasons = [];
    this.episodes = [];
    this.onSwitchEpisodeCallback = undefined;
    this.liveChannels = [];
    this.onSwitchChannelCallback = undefined;

    this.isPlayingEmbeddedSubject.next(false);
    this.restoreScrollPosition();
  }

  public async startPlayer(
    channel: Channel,
    hostElementOrId: HTMLElement | string,
    options?: EmbeddedPlayerOptions,
  ): Promise<void> {
    if (channel?.id) {
      invoke('add_last_watched', { id: channel.id }).catch(console.warn);
      this.lastWatchedUpdated$.next(channel.id);
    }

    const wasAlreadyPlaying = this.isPlayingEmbedded;
    if (wasAlreadyPlaying) {
      this.isRestartingPlayer = true;
      try {
        await invoke('stop_embedded_poc');
      } catch (e) {
        console.warn('stop_embedded_poc error', e);
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
    } else {
      this.saveScrollPosition();
      this.hostTarget = hostElementOrId;
      this.isPlayingEmbeddedSubject.next(true);
      document.body.classList.add('theater-mode-active');
      await this.setupTauriListeners();
    }

    this.currentChannel = channel;
    this.currentMode = options?.mode || (wasAlreadyPlaying ? this.currentMode : 'movie');

    // TV episode switcher options
    if (options?.seriesChannel) this.seriesChannel = options.seriesChannel;
    if (options?.seriesTitle) {
      this.seriesTitle = options.seriesTitle;
    } else if (this.currentMode === 'episode' && !this.seriesTitle) {
      this.seriesTitle = this.extractSeriesTitle(channel);
    }
    if (options?.seasons) this.seasons = options.seasons;
    if (options?.currentSeasonNum) {
      this.currentSeasonNum = options.currentSeasonNum;
    } else if (this.currentMode === 'episode') {
      this.currentSeasonNum = this.extractSeasonNumber(channel);
    }
    if (options?.episodes && options.episodes.length > 0) {
      this.episodes = options.episodes;
    } else if (this.currentMode === 'episode') {
      if (this.seasons.length > 0) {
        const targetSeason = this.seasons.find((s) => s.seasonNum === this.currentSeasonNum) || this.seasons[0];
        if (targetSeason) {
          this.loadEpisodesForSeason(targetSeason.id, targetSeason.seasonNum).catch(console.warn);
        }
      } else if (channel.series_id || (channel.url && /^\d+$/.test(channel.url.trim()))) {
        this.loadSeriesAndSeasons(channel, this.currentSeasonNum).catch(console.warn);
      }
    }
    if (options?.onSwitchEpisode) this.onSwitchEpisodeCallback = options.onSwitchEpisode;

    // Live TV channel switcher options
    this.currentGroupId = options?.currentGroupId ?? channel.group_id;
    if (options?.channels && options.channels.length > 0) {
      this.liveChannels = options.channels.map((c: any) => ({
        id: c.id,
        name: cleanMediaTitle(c.name || 'Channel'),
        logo: c.logo || c.image,
        group: c.group,
        group_id: c.group_id || c.channel?.group_id,
        isCurrent: c.id === channel.id,
        channel: c.channel || c,
      }));
    } else if (this.currentMode === 'live' && this.liveChannels.length === 0) {
      this.loadLiveChannels().catch(console.warn);
    } else {
      this.liveChannels = this.liveChannels.map((c) => ({
        ...c,
        isCurrent: c.id === channel.id,
      }));
    }
    if (options?.onSwitchChannel) this.onSwitchChannelCallback = options.onSwitchChannel;

    const startPos =
      options?.startTime ??
      (this.currentMode !== 'live' && channel.id
        ? this.getSavedPosition(channel.id, channel)
        : 0);

    const playChannel: Channel = {
      ...channel,
      name: options?.title || channel.name,
    };

    emit('embedded-player-mode', { mode: this.currentMode, channelId: channel.id }).catch(console.warn);

    try {
      // Wait a frame so layout/bounding rect computes
      await new Promise((resolve) => requestAnimationFrame(resolve));

      let el = this.getHostElement();
      if (!el) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        el = this.getHostElement();
      }

      let x = 0,
        y = 0,
        width = 800,
        height = 600;
      if (el) {
        const rect = el.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        x = Math.round(rect.x * dpr);
        y = Math.round(rect.y * dpr);
        width = Math.round(rect.width * dpr);
        height = Math.round(rect.height * dpr);
      }

      await invoke('start_embedded_player', {
        channel: playChannel,
        x,
        y,
        width,
        height,
        zOrder: 'top',
      });

      emit('embedded-player-started', {
        name: options?.title || channel.name,
        channel_id: channel.id,
        channelId: channel.id,
        startTime: startPos,
      }).catch(console.warn);
      emit('embedded-player-mode', { mode: this.currentMode, channelId: channel.id }).catch(console.warn);
      emit('overlay-top-crop', { crop: 32 }).catch(console.warn);

      if (startPos > 5 && this.currentMode !== 'live') {
        setTimeout(() => {
          if (this.isPlayingEmbedded && this.currentMode !== 'live') {
            invoke('send_embedded_poc_ipc', {
              command: JSON.stringify({ command: ['seek', startPos, 'absolute'] }),
            }).catch(console.warn);
          }
        }, 400);
        setTimeout(() => {
          if (this.isPlayingEmbedded && this.currentMode !== 'live') {
            invoke('send_embedded_poc_ipc', {
              command: JSON.stringify({ command: ['seek', startPos, 'absolute'] }),
            }).catch(console.warn);
          }
        }, 1200);
      }

      if (this.currentMode === 'episode') {
        this.emitEpisodesData();
      } else if (this.currentMode === 'live') {
        this.emitChannelsData();
      }

      if (!wasAlreadyPlaying) {
        this.attachKeyHandler();
        this.setupVideoResizeObserver();
      }
      setTimeout(() => this.syncBounds(), 50);
      setTimeout(() => this.syncBounds(), 150);
    } catch (err) {
      console.error('start_embedded_player failed:', err);
      if (!wasAlreadyPlaying) {
        await this.stopPlayer();
      }
      throw err;
    } finally {
      if (wasAlreadyPlaying) {
        setTimeout(() => {
          this.isRestartingPlayer = false;
        }, 200);
      }
    }
  }

  public emitEpisodesData(): void {
    emit('embedded-player-episodes-data', {
      seriesTitle: this.seriesTitle,
      seasons: this.seasons,
      currentSeasonNum: this.currentSeasonNum,
      currentEpisodeId: this.currentChannel?.id,
      episodes: this.episodes.map((e) => ({
        ...e,
        isCurrent: e.id === this.currentChannel?.id,
      })),
    }).catch(console.warn);
  }

  public emitChannelsData(): void {
    const sourceIds = Array.from(this.memory.Sources.keys());
    emit('embedded-player-channels-data', {
      currentChannelId: this.currentChannel?.id,
      currentGroupId: this.currentGroupId ?? this.currentChannel?.group_id,
      sourceIds: sourceIds,
      channels: this.liveChannels.map((c) => ({
        ...c,
        isCurrent: c.id === this.currentChannel?.id,
      })),
    }).catch(console.warn);
  }

  public async switchChannel(channel: Channel, title?: string): Promise<void> {
    if (!channel || channel.id == null) return;
    this.currentChannel = channel;
    if (channel.id) {
      invoke('add_last_watched', { id: channel.id }).catch(console.warn);
      this.lastWatchedUpdated$.next(channel.id);
    }
    if (channel.group_id != null) {
      this.currentGroupId = channel.group_id;
    }
    const channelTitle = title || cleanMediaTitle(channel.name || 'Live TV');

    if (this.onSwitchChannelCallback) {
      try {
        await this.onSwitchChannelCallback(channel);
      } catch (e) {
        console.warn('onSwitchChannelCallback error:', e);
      }
    }

    try {
      await invoke('switch_embedded_channel', { channel });
    } catch (err) {
      console.warn('switch_embedded_channel error, falling back to startPlayer:', err);
      await this.startPlayer(channel, this.hostTarget || 'home-video-canvas', {
        mode: 'live',
        title: channelTitle,
      });
    }

    this.emitChannelsData();
  }

  public async loadEpisodesForSeason(seasonId: number, seasonNum: number): Promise<void> {
    const seriesChannel = this.seriesChannel || this.currentChannel;
    if (!seriesChannel) return;
    try {
      const seriesId =
        seriesChannel.series_id ||
        (seriesChannel.url && /^\d+$/.test(seriesChannel.url.trim())
          ? parseInt(seriesChannel.url.trim(), 10)
          : seriesChannel.id);
      const sourceIds = seriesChannel.source_id
        ? [seriesChannel.source_id]
        : Array.from(this.memory.Sources.keys());

      const filters = {
        source_ids: sourceIds,
        series_id: seriesId,
        season: seasonId,
        media_types: [MediaType.movie],
        view_type: ViewMode.All,
        use_keywords: false,
        page: 1,
        sort: SortType.alphabeticalAscending,
      };

      const episodeChannels = (await invoke('search', { filters })) as Channel[];
      if (episodeChannels && episodeChannels.length > 0) {
        this.currentSeasonNum = seasonNum;
        this.episodes = episodeChannels.map((ch, idx) => {
          const epNum = ch.episode_num ?? (idx + 1);
          return {
            id: ch.id!,
            channel: ch,
            episodeNum: epNum,
            seasonNum: seasonNum,
            title: cleanMediaTitle(ch.name || `Episode ${epNum}`),
            stillUrl: ch.image,
            isWatched: (ch as any).last_watched != null,
            isCurrent: ch.id === this.currentChannel?.id,
          };
        });
        this.emitEpisodesData();
      } else if (this.episodes.length > 0) {
        this.emitEpisodesData();
      }
    } catch (e) {
      console.warn('Failed to load episodes for season in embedded player:', e);
    }
  }

  public extractSeasonNumber(channel?: Channel): number {
    if (!channel) return 1;
    const chAny = channel as any;
    if (chAny.seasonNum != null && chAny.seasonNum > 0) return Number(chAny.seasonNum);
    if (chAny.season_number != null && chAny.season_number > 0) return Number(chAny.season_number);
    if (chAny.season != null && typeof chAny.season === 'number' && chAny.season > 0) return chAny.season;
    const name = channel.name || '';
    const sMatch = name.match(/\b(?:s|season\s*)(\d{1,2})[\s._-]*(?:e|ep|episode|\b)/i) ||
                  name.match(/\b(\d{1,2})x\d{1,2}\b/i);
    if (sMatch) {
      const parsed = parseInt(sMatch[1], 10);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    return 1;
  }

  public extractEpisodeNumber(name?: string): number {
    if (!name) return 1;
    const match =
      name.match(/\b(?:e|ep|episode)[\s._-]*(\d{1,3})\b/i) ||
      name.match(/\b\d{1,2}x(\d{1,3})\b/i);
    if (match) {
      const parsed = parseInt(match[1], 10);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    return 1;
  }

  public extractSeriesTitle(channel?: Channel): string {
    if (!channel || !channel.name) return '';
    if (this.seriesTitle) return this.seriesTitle;
    if (this.seriesChannel?.name) return cleanMediaTitle(this.seriesChannel.name);
    const name = channel.name;
    const match = name.match(/^(.*?)(?:[\s._-]+(?:s\d{1,2}\s*e\d{1,3}|\d{1,2}x\d{1,3}|season\s*\d+|ep(?:isode)?\s*\d+))/i);
    if (match && match[1].trim()) {
      return cleanMediaTitle(match[1].trim());
    }
    return cleanMediaTitle(name);
  }

  public async loadSeriesAndSeasons(channel: Channel, targetSeasonNum: number): Promise<void> {
    try {
      const seriesId = channel.series_id || (channel.url && /^\d+$/.test(channel.url.trim()) ? parseInt(channel.url.trim(), 10) : undefined);
      if (!seriesId) return;

      if (!this.seriesTitle || !this.seriesChannel) {
        if (!this.seriesTitle) {
          this.seriesTitle = this.extractSeriesTitle(channel);
        }
        try {
          const sourceIds = channel.source_id
            ? [channel.source_id]
            : Array.from(this.memory.Sources.keys());
          const seriesList = (await invoke('search', {
            filters: {
              source_ids: sourceIds,
              series_id: undefined,
              media_types: [MediaType.serie],
              view_type: ViewMode.All,
              use_keywords: false,
              query: String(seriesId),
              page: 1,
              sort: SortType.alphabeticalAscending,
            },
          })) as Channel[];
          const matchedSeries = seriesList.find((s) => s.url === String(seriesId) || s.id === seriesId);
          if (matchedSeries) {
            this.seriesChannel = matchedSeries;
            this.seriesTitle = cleanMediaTitle(matchedSeries.name || '') || this.seriesTitle;
          }
        } catch {}
      }

      const sourceIds = channel.source_id
        ? [channel.source_id]
        : Array.from(this.memory.Sources.keys());
      const filters = {
        source_ids: sourceIds,
        series_id: seriesId,
        media_types: [MediaType.serie],
        view_type: ViewMode.All,
        use_keywords: false,
        page: 1,
        sort: SortType.alphabeticalAscending,
      };
      const seasonChannels = (await invoke('search', { filters })) as Channel[];
      if (seasonChannels && seasonChannels.length > 0) {
        this.seasons = seasonChannels.map((s, idx) => {
          const sMatch = s.name?.match(/(\d+)/);
          return {
            id: s.id!,
            seasonNum: sMatch ? parseInt(sMatch[1], 10) : idx + 1,
            name: s.name || `Season ${idx + 1}`,
          };
        });
        const targetSeason = this.seasons.find((s) => s.seasonNum === targetSeasonNum) || this.seasons[0];
        if (targetSeason) {
          await this.loadEpisodesForSeason(targetSeason.id, targetSeason.seasonNum);
        }
      }
    } catch (e) {
      console.warn('Failed to load series and seasons in embedded player:', e);
    }
  }

  public async loadLiveChannels(): Promise<void> {
    try {
      const sourceIds = Array.from(this.memory.Sources.keys());
      const filters = {
        source_ids: sourceIds,
        media_types: [MediaType.livestream],
        view_type: ViewMode.All,
        use_keywords: false,
        page: 1,
        sort: SortType.provider,
      };
      const channels = (await invoke('search', { filters })) as Channel[];
      this.liveChannels = (channels || [])
        .filter((c) => (c.media_type === MediaType.livestream || c.media_type == null) && c.id != null)
        .map((c) => ({
          id: c.id!,
          name: cleanMediaTitle(c.name || 'Live Channel'),
          logo: c.image,
          isCurrent: c.id === this.currentChannel?.id,
          channel: c,
        }));

      this.emitChannelsData();
    } catch (e) {
      console.warn('Failed to load live channels in embedded player:', e);
    }
  }

  public getSavedPosition(channelId?: number, channel?: Channel): number {
    if (!channelId && !channel?.id) return 0;
    const id = channelId || channel?.id;
    try {
      const storeRaw = localStorage.getItem('fred_tv_watch_progress');
      if (storeRaw) {
        const store = JSON.parse(storeRaw);
        if (store && id && store[id]) {
          const entry = store[id];
          const t = typeof entry === 'number' ? entry : (entry.time || 0);
          const dur = entry.duration || 0;
          if (dur > 0 && (t >= dur - 30 || (t / dur) > 0.95)) {
            return 0;
          }
          if (t > 5) return Math.round(t);
        }
      }
      const posRaw = localStorage.getItem(`playback_pos_${id}`);
      if (posRaw) {
        const pos = parseFloat(posRaw);
        const durRaw = localStorage.getItem(`playback_dur_${id}`);
        const dur = durRaw ? parseFloat(durRaw) : 0;
        if (dur > 0 && (pos >= dur - 30 || (pos / dur) > 0.95)) {
          return 0;
        }
        if (!isNaN(pos) && pos > 5) {
          return Math.round(pos);
        }
      }
      const chAny = channel as any;
      if (chAny?.progress && chAny.progress > 5) {
        return Math.round(chAny.progress);
      }
    } catch (e) {
      console.warn('Error reading saved position:', e);
    }
    return 0;
  }

  public saveWatchProgress(channelId: number, time: number, duration: number): void {
    if (!channelId || time <= 0) return;
    try {
      if (duration <= 0) {
        const prevDur = localStorage.getItem(`playback_dur_${channelId}`);
        if (prevDur) duration = parseFloat(prevDur) || 0;
      }
      const pct = duration > 0 ? Math.min(100, Math.max(0, Math.round((time / duration) * 100))) : 0;
      localStorage.setItem(`playback_pos_${channelId}`, String(time));
      if (duration > 0) {
        localStorage.setItem(`playback_dur_${channelId}`, String(duration));
        localStorage.setItem(`watch_progress_${channelId}`, String(pct));
      }

      let store: Record<string, any> = {};
      const storeRaw = localStorage.getItem('fred_tv_watch_progress');
      if (storeRaw) {
        try {
          store = JSON.parse(storeRaw) || {};
        } catch {
          store = {};
        }
      }
      store[channelId] = {
        time,
        duration: duration > 0 ? duration : (store[channelId]?.duration || 0),
        percent: pct > 0 ? pct : (store[channelId]?.percent || 0),
        updatedAt: Date.now(),
      };
      localStorage.setItem('fred_tv_watch_progress', JSON.stringify(store));
    } catch (e) {
      console.warn('Failed to save watch progress:', e);
    }
  }

  ngOnDestroy(): void {
    if (this.routerSubscription) {
      this.routerSubscription.unsubscribe();
    }
    if (this.unlistenRequestMode) this.unlistenRequestMode();
    if (this.unlistenRequestCrop) this.unlistenRequestCrop();
    if (this.unlistenGlobalStopped) this.unlistenGlobalStopped();
    if (this.unlistenPlayerStarted) this.unlistenPlayerStarted();
    if (this.unlistenRequestEpisodes) this.unlistenRequestEpisodes();
    if (this.unlistenChangeSeason) this.unlistenChangeSeason();
    if (this.unlistenSelectEpisode) this.unlistenSelectEpisode();
    if (this.unlistenRequestChannels) this.unlistenRequestChannels();
    if (this.unlistenSelectChannel) this.unlistenSelectChannel();
    if (this.unlistenSaveProgress) this.unlistenSaveProgress();
  }
}
