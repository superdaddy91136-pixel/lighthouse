import {
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  OnInit,
  ViewChild,
  ChangeDetectorRef,
} from '@angular/core';
import { Subscription } from 'rxjs';
import { PlaybackService } from '../services/playback.service';
import { EmbeddedEngineService } from '../services/embedded-engine.service';
import { PlaybackPayload, PlaybackTrack, PlayerState } from '../models/playback';
import { ChannelSwitcherComponent } from '../channel-switcher/channel-switcher.component';
import { EpisodeSwitcherComponent } from '../episode-switcher/episode-switcher.component';
import { Channel } from '../models/channel';

@Component({
  selector: 'app-player',
  templateUrl: './player.component.html',
  styleUrls: ['./player.component.css'],
})
export class PlayerComponent implements OnInit, OnDestroy {
  @ViewChild('videoPlayer') videoPlayerRef!: ElementRef<HTMLVideoElement>;
  @ViewChild(ChannelSwitcherComponent) channelSwitcher?: ChannelSwitcherComponent;
  @ViewChild(EpisodeSwitcherComponent) episodeSwitcher?: EpisodeSwitcherComponent;

  isOpen = false;
  payload: PlaybackPayload | null = null;
  playerState: PlayerState = 'idle';

  currentTime = 0;
  duration = 0;
  bufferedEnd = 0;
  volume = 1;
  isMuted = false;
  isFullscreen = false;
  playbackRate = 1;
  isLive = false;

  controlsVisible = true;
  private controlsTimeout: any = null;
  private saveProgressInterval: any = null;

  // Track selection
  showTracksMenu = false;
  audioTracks: PlaybackTrack[] = [];
  subtitleTracks: PlaybackTrack[] = [];
  activeAudioTrackId: number | string | null = null;
  activeSubtitleTrackId: number | string | null = null;
  activeTab: 'audio' | 'subtitles' = 'audio';

  // Quick feedback animation (play, pause, forward, backward)
  feedbackType: 'play' | 'pause' | 'forward' | 'backward' | null = null;
  private feedbackTimeout: any = null;

  // Speeds available
  readonly speeds = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
  showSpeedMenu = false;

  private subscriptions: Subscription[] = [];

  constructor(
    public playbackService: PlaybackService,
    private engineService: EmbeddedEngineService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    // Subscribe to player open state
    this.subscriptions.push(
      this.playbackService.isPlayerOpen$.subscribe((open) => {
        this.isOpen = open;
        if (!open) {
          this.teardown();
        }
        this.cdr.markForCheck();
      })
    );

    // Subscribe to playback payload
    this.subscriptions.push(
      this.playbackService.currentPlayback$.subscribe(async (payload) => {
        if (payload && this.isOpen) {
          this.payload = payload;
          this.isLive = payload.playbackType === 'live';
          await this.initPlayback(payload);
        }
      })
    );
  }

  ngOnDestroy(): void {
    this.teardown();
    this.subscriptions.forEach((s) => s.unsubscribe());
  }

  private async initPlayback(payload: PlaybackPayload): Promise<void> {
    this.playerState = 'loading';
    this.currentTime = 0;
    this.duration = 0;
    this.bufferedEnd = 0;
    this.controlsVisible = true;
    this.resetControlsTimer();

    // Give DOM time to render <video> element if newly opened
    setTimeout(async () => {
      const video = this.videoPlayerRef?.nativeElement;
      if (!video) return;

      video.volume = this.volume;
      video.muted = this.isMuted;
      video.playbackRate = this.playbackRate;

      try {
        const result = await this.engineService.loadStream(
          video,
          payload.streamUrl,
          payload.initialTime || 0,
          payload.playbackType === 'live'
        );

        this.isLive = result.isLive;
        await video.play().catch((playErr) => {
          console.warn('Auto-play blocked or delayed:', playErr);
        });

        this.playerState = 'playing';
        this.refreshTracks();
        this.startProgressSaving();
      } catch (err: any) {
        console.error('Embedded playback failed:', err);
        this.playerState = 'error';
        // Graceful automatic fallback to MPV
        await this.playbackService.fallbackToMpv(
          payload.channel,
          'Embedded engine unable to decode stream format. Switching to MPV player...'
        );
      }
      this.cdr.markForCheck();
    }, 50);
  }

  // ── Video Events ──────────────────────────────────────────

  onTimeUpdate(): void {
    const video = this.videoPlayerRef?.nativeElement;
    if (!video) return;

    this.currentTime = video.currentTime;
    if (isFinite(video.duration)) {
      this.duration = video.duration;
    }

    if (video.buffered.length > 0) {
      this.bufferedEnd = video.buffered.end(video.buffered.length - 1);
    }
  }

  onPlay(): void {
    this.playerState = 'playing';
    this.resetControlsTimer();
    this.triggerFeedback('play');
    this.cdr.markForCheck();
  }

  onPause(): void {
    this.playerState = 'paused';
    this.showControls();
    this.triggerFeedback('pause');
    this.cdr.markForCheck();
  }

  onWaiting(): void {
    if (this.playerState !== 'loading') {
      this.playerState = 'buffering';
      this.cdr.markForCheck();
    }
  }

  onPlaying(): void {
    this.playerState = 'playing';
    this.cdr.markForCheck();
  }

  onEnded(): void {
    this.playerState = 'ended';
    this.showControls();
    if (this.payload?.playbackType === 'episode') {
      this.playbackService.playNextEpisode();
    }
    this.cdr.markForCheck();
  }

  onError(): void {
    const video = this.videoPlayerRef?.nativeElement;
    if (video && video.error && this.isOpen && this.payload) {
      console.warn('HTML5 Video Error encountered:', video.error);
      this.playbackService.fallbackToMpv(
        this.payload.channel,
        'Stream playback error. Launching MPV player fallback...'
      );
    }
  }

  // ── Controls Actions ─────────────────────────────────────

  togglePlay(): void {
    const video = this.videoPlayerRef?.nativeElement;
    if (!video) return;

    if (video.paused) {
      video.play().catch(console.warn);
    } else {
      video.pause();
    }
  }

  seek(deltaSeconds: number): void {
    const video = this.videoPlayerRef?.nativeElement;
    if (!video || this.isLive) return;

    const newTime = Math.min(this.duration, Math.max(0, video.currentTime + deltaSeconds));
    video.currentTime = newTime;
    this.currentTime = newTime;

    if (deltaSeconds > 0) {
      this.triggerFeedback('forward');
    } else {
      this.triggerFeedback('backward');
    }
  }

  onSeekInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    const value = parseFloat(target.value);
    this.currentTime = value;
  }

  onSeekChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    const value = parseFloat(target.value);
    const video = this.videoPlayerRef?.nativeElement;
    if (video && isFinite(value)) {
      video.currentTime = value;
      this.currentTime = value;
    }
  }

  jumpToLive(): void {
    this.engineService.jumpToLiveEdge();
    this.triggerFeedback('forward');
  }

  setVolume(vol: number): void {
    const video = this.videoPlayerRef?.nativeElement;
    this.volume = Math.min(1, Math.max(0, vol));
    if (video) {
      video.volume = this.volume;
      if (this.volume === 0) {
        video.muted = true;
        this.isMuted = true;
      } else if (this.isMuted) {
        video.muted = false;
        this.isMuted = false;
      }
    }
    this.cdr.markForCheck();
  }

  toggleMute(): void {
    const video = this.videoPlayerRef?.nativeElement;
    this.isMuted = !this.isMuted;
    if (video) {
      video.muted = this.isMuted;
    }
    this.cdr.markForCheck();
  }

  setPlaybackRate(rate: number): void {
    const video = this.videoPlayerRef?.nativeElement;
    this.playbackRate = rate;
    if (video) {
      video.playbackRate = rate;
    }
    this.showSpeedMenu = false;
    this.cdr.markForCheck();
  }

  toggleFullscreen(): void {
    const elem = document.querySelector('.fred-player-container');
    if (!elem) return;

    if (!document.fullscreenElement) {
      elem.requestFullscreen().then(() => {
        this.isFullscreen = true;
        this.cdr.markForCheck();
      }).catch(console.warn);
    } else {
      document.exitFullscreen().then(() => {
        this.isFullscreen = false;
        this.cdr.markForCheck();
      }).catch(console.warn);
    }
  }

  close(): void {
    if (this.payload && this.payload.channel.id != null && !this.isLive) {
      this.playbackService.savePlaybackPosition(
        this.payload.channel.id,
        this.currentTime,
        this.duration
      );
    }
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
    this.playbackService.closePlayer();
  }

  switchToMpv(): void {
    this.playbackService.switchToExternalMpv();
  }

  // ── Tracks & Audio ──────────────────────────────────────

  refreshTracks(): void {
    this.audioTracks = this.engineService.getAudioTracks();
    this.subtitleTracks = this.engineService.getSubtitleTracks();

    const activeAudio = this.audioTracks.find((t) => t.active);
    this.activeAudioTrackId = activeAudio ? activeAudio.id : null;

    const activeSub = this.subtitleTracks.find((t) => t.active);
    this.activeSubtitleTrackId = activeSub ? activeSub.id : null;
  }

  toggleTracksMenu(): void {
    this.refreshTracks();
    this.showTracksMenu = !this.showTracksMenu;
    this.showSpeedMenu = false;
    this.showControls();
  }

  selectAudioTrack(trackId: number | string): void {
    this.engineService.selectAudioTrack(trackId);
    this.activeAudioTrackId = trackId;
    this.refreshTracks();
  }

  selectSubtitleTrack(trackId: number | string | null): void {
    this.engineService.selectSubtitleTrack(trackId);
    this.activeSubtitleTrackId = trackId;
    this.refreshTracks();
  }

  // ── In-Player Navigation ────────────────────────────────

  toggleChannelSwitcher(): void {
    if (this.payload?.channel && this.channelSwitcher) {
      this.channelSwitcher.open(this.payload.channel);
    }
  }

  toggleEpisodeSwitcher(): void {
    if (this.payload?.showChannel && this.payload.channel && this.episodeSwitcher) {
      this.episodeSwitcher.open(this.payload.showChannel, this.payload.channel);
    }
  }

  onChannelSwitched(newChannel: Channel): void {
    this.playbackService.playLiveChannel(newChannel, this.payload?.channelsList);
  }

  onEpisodeSwitched(newChannel: Channel): void {
    if (this.payload?.showChannel) {
      this.playbackService.playEpisode(
        newChannel,
        this.payload.showChannel,
        this.payload.episodesList
      );
    }
  }

  // ── UI Auto-Hide & Mouse Move ───────────────────────────

  @HostListener('mousemove')
  @HostListener('click')
  onUserActivity(): void {
    this.showControls();
    if (this.playerState === 'playing' && !this.showTracksMenu && !this.showSpeedMenu) {
      this.resetControlsTimer();
    }
  }

  private showControls(): void {
    this.controlsVisible = true;
    this.cdr.markForCheck();
  }

  private resetControlsTimer(): void {
    if (this.controlsTimeout) {
      clearTimeout(this.controlsTimeout);
    }
    this.controlsTimeout = setTimeout(() => {
      if (this.playerState === 'playing' && !this.showTracksMenu && !this.showSpeedMenu) {
        this.controlsVisible = false;
        this.cdr.markForCheck();
      }
    }, 3500);
  }

  // ── Keyboard Shortcuts ──────────────────────────────────

  @HostListener('window:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent): void {
    if (!this.isOpen) return;

    // Ignore if typing in an input
    const tag = (event.target as HTMLElement)?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;

    switch (event.key) {
      case ' ':
      case 'k':
      case 'K':
        event.preventDefault();
        this.togglePlay();
        break;
      case 'ArrowLeft':
      case 'j':
      case 'J':
        event.preventDefault();
        this.seek(-10);
        break;
      case 'ArrowRight':
      case 'l':
      case 'L':
        event.preventDefault();
        this.seek(10);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.setVolume(this.volume + 0.05);
        this.showControls();
        break;
      case 'ArrowDown':
        event.preventDefault();
        this.setVolume(this.volume - 0.05);
        this.showControls();
        break;
      case 'm':
      case 'M':
        event.preventDefault();
        this.toggleMute();
        break;
      case 'f':
      case 'F':
        event.preventDefault();
        this.toggleFullscreen();
        break;
      case 'Escape':
        event.preventDefault();
        if (this.showTracksMenu || this.showSpeedMenu) {
          this.showTracksMenu = false;
          this.showSpeedMenu = false;
        } else if (document.fullscreenElement) {
          document.exitFullscreen().catch(() => {});
        } else {
          this.close();
        }
        break;
      case '[':
        event.preventDefault();
        if (this.payload?.playbackType === 'episode') {
          this.playbackService.playPreviousEpisode();
        } else if (this.payload?.playbackType === 'live') {
          this.playbackService.playPreviousChannel();
        }
        break;
      case ']':
        event.preventDefault();
        if (this.payload?.playbackType === 'episode') {
          this.playbackService.playNextEpisode();
        } else if (this.payload?.playbackType === 'live') {
          this.playbackService.playNextChannel();
        }
        break;
    }
  }

  // ── Feedback Ripple ─────────────────────────────────────

  private triggerFeedback(type: 'play' | 'pause' | 'forward' | 'backward'): void {
    this.feedbackType = type;
    if (this.feedbackTimeout) {
      clearTimeout(this.feedbackTimeout);
    }
    this.feedbackTimeout = setTimeout(() => {
      this.feedbackType = null;
      this.cdr.markForCheck();
    }, 700);
  }

  // ── Watch Progress Saving ───────────────────────────────

  private startProgressSaving(): void {
    this.stopProgressSaving();
    this.saveProgressInterval = setInterval(() => {
      if (
        this.payload &&
        this.payload.channel.id != null &&
        !this.isLive &&
        this.playerState === 'playing'
      ) {
        this.playbackService.savePlaybackPosition(
          this.payload.channel.id,
          this.currentTime,
          this.duration
        );
      }
    }, 4000);
  }

  private stopProgressSaving(): void {
    if (this.saveProgressInterval) {
      clearInterval(this.saveProgressInterval);
      this.saveProgressInterval = null;
    }
  }

  private teardown(): void {
    this.stopProgressSaving();
    if (this.controlsTimeout) {
      clearTimeout(this.controlsTimeout);
      this.controlsTimeout = null;
    }
    this.engineService.destroyCurrent();
    this.playerState = 'idle';
    this.showTracksMenu = false;
    this.showSpeedMenu = false;
  }

  formatTime(seconds: number): string {
    if (isNaN(seconds) || seconds < 0) return '00:00';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    const m = mins < 10 ? '0' + mins : mins.toString();
    const s = secs < 10 ? '0' + secs : secs.toString();

    if (hrs > 0) {
      const h = hrs < 10 ? '0' + hrs : hrs.toString();
      return `${h}:${m}:${s}`;
    }
    return `${m}:${s}`;
  }

  get remainingTime(): string {
    if (!this.duration || this.duration <= 0) return '';
    const rem = Math.max(0, this.duration - this.currentTime);
    return `-${this.formatTime(rem)}`;
  }

  get seekPercentage(): number {
    if (!this.duration || this.duration <= 0) return 0;
    return Math.min(100, (this.currentTime / this.duration) * 100);
  }

  get bufferedPercentage(): number {
    if (!this.duration || this.duration <= 0) return 0;
    return Math.min(100, (this.bufferedEnd / this.duration) * 100);
  }
}
