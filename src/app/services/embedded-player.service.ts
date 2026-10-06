import { Injectable, NgZone } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { ToastrService } from 'ngx-toastr';
import { BehaviorSubject, Observable } from 'rxjs';
import { Channel } from '../models/channel';
import { MediaType } from '../models/mediaType';
import { cleanMediaTitle } from '../utils/media-presentation';
import { isInputFocused } from '../utils';

export interface EmbeddedPlayerOptions {
  title?: string;
}

@Injectable({
  providedIn: 'root',
})
export class EmbeddedPlayerService {
  private isPlayingEmbeddedSubject = new BehaviorSubject<boolean>(false);
  public isPlayingEmbedded$: Observable<boolean> = this.isPlayingEmbeddedSubject.asObservable();

  private isFullscreenSubject = new BehaviorSubject<boolean>(false);
  public isFullscreen$: Observable<boolean> = this.isFullscreenSubject.asObservable();

  public get isPlayingEmbedded(): boolean {
    return this.isPlayingEmbeddedSubject.value;
  }

  public get isFullscreen(): boolean {
    return this.isFullscreenSubject.value;
  }

  private hostTarget: HTMLElement | string | null = null;
  private currentChannel?: Channel;
  private activeFallbackChannel?: Channel;
  private videoResizeObserver: ResizeObserver | null = null;
  private syncScheduled: boolean = false;
  private boundScrollHandler = () => this.syncBounds();
  private boundKeyDownHandler = (e: KeyboardEvent) => this.handleKeyDown(e);
  private keyHandlerAttached: boolean = false;

  private unlistenStopped?: UnlistenFn;
  private unlistenFullscreen?: UnlistenFn;
  private unlistenSyncBounds?: UnlistenFn;
  private unlistenAspect?: UnlistenFn;
  private unlistenRequestExternal?: UnlistenFn;
  private unlistenPlayerStarted?: UnlistenFn;

  private savedScrollTop: number = 0;
  private savedMainScrollTop: number = 0;

  constructor(
    private ngZone: NgZone,
    private toastr: ToastrService,
  ) {
    this.initGlobalListeners();
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
        }
      });
    });

    // Listen for external MPV open request from the overlay
    this.unlistenRequestExternal = await listen('request-open-external-mpv', (event: any) => {
      this.ngZone.run(() => {
        const pos = event?.payload?.position;
        this.openExternal(undefined, pos);
      });
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
      invoke('send_embedded_poc_ipc', {
        command: JSON.stringify({ command: ['seek', -10, 'relative'] }),
      }).catch(console.warn);
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (event.key === 'ArrowRight') {
      invoke('send_embedded_poc_ipc', {
        command: JSON.stringify({ command: ['seek', 10, 'relative'] }),
      }).catch(console.warn);
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (event.key === 'ArrowUp') {
      invoke('send_embedded_poc_ipc', {
        command: JSON.stringify({ command: ['add', 'volume', 5] }),
      }).catch(console.warn);
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (event.key === 'ArrowDown') {
      invoke('send_embedded_poc_ipc', {
        command: JSON.stringify({ command: ['add', 'volume', -5] }),
      }).catch(console.warn);
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

    if (event.key === 'm' || event.key === 'M') {
      invoke('send_embedded_poc_ipc', {
        command: JSON.stringify({ command: ['cycle', 'mute'] }),
      }).catch(console.warn);
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
    this.cleanupVideoResizeObserver();
    this.removeKeyHandler();
    this.cleanupTauriListeners();

    this.currentChannel = undefined;
    this.activeFallbackChannel = undefined;

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
    this.isPlayingEmbeddedSubject.next(false);
    this.restoreScrollPosition();
  }

  public async openExternal(customChannel?: Channel, position?: number): Promise<void> {
    const channel = customChannel || this.currentChannel || this.activeFallbackChannel;
    if (!channel || !channel.id) {
      this.toastr.info('No active stream playing to open in external player');
      return;
    }

    const channelTitle = cleanMediaTitle(channel.name || 'stream');

    try {
      this.toastr.info(`Opening "${channelTitle}" in external MPV...`);

      // 1. Stop embedded player (which releases child HWND, restores layout, scroll position)
      if (this.isPlayingEmbedded) {
        await this.stopPlayer();
      } else {
        try {
          await invoke('stop_embedded_poc');
        } catch (e) {
          console.warn('stop_embedded_poc error', e);
        }
      }

      // Brief delay for Win32 child window release before spawning external MPV
      await new Promise((resolve) => setTimeout(resolve, 80));

      // 2. Play channel in external MPV via existing Tauri command
      // Note: invoke('play') currently takes { channel, record, recordPath }.
      // Resume argument (--start) is not supported by the existing Rust play command,
      // but position is captured for reference.
      await invoke('play', {
        channel: channel,
        record: false,
        recordPath: undefined,
      });
    } catch (err) {
      console.error('Failed to open external MPV:', err);
      this.toastr.error('Failed to launch external MPV player');
    }
  }

  public async startPlayer(
    channel: Channel,
    hostElementOrId: HTMLElement | string,
    options?: EmbeddedPlayerOptions,
  ): Promise<void> {
    if (this.isPlayingEmbedded) {
      await this.stopPlayer();
    }

    this.saveScrollPosition();
    this.hostTarget = hostElementOrId;
    this.currentChannel = channel;

    const playChannel: Channel = {
      ...channel,
      name: options?.title || channel.name,
    };

    this.isPlayingEmbeddedSubject.next(true);
    document.body.classList.add('theater-mode-active');

    await this.setupTauriListeners();

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

      this.attachKeyHandler();
      this.setupVideoResizeObserver();
      setTimeout(() => this.syncBounds(), 50);
      setTimeout(() => this.syncBounds(), 150);
    } catch (err) {
      this.currentChannel = undefined;
      this.cleanupVideoResizeObserver();
      this.removeKeyHandler();
      this.cleanupTauriListeners();
      this.isPlayingEmbeddedSubject.next(false);
      document.body.classList.remove('theater-mode-active');
      document.body.classList.remove('fullscreen-player-active');
      this.restoreScrollPosition();
      throw err;
    }
  }
}
