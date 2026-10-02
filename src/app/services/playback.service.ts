import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { Channel } from '../models/channel';
import { PlaybackMetadata, PlaybackPayload, PlaybackType } from '../models/playback';
import { MediaType } from '../models/mediaType';
import { ToastrService } from 'ngx-toastr';
import { ErrorService } from '../error.service';
import { invoke } from '@tauri-apps/api/core';
import { cleanMediaTitle } from '../utils/media-presentation';

@Injectable({
  providedIn: 'root',
})
export class PlaybackService {
  readonly currentPlayback$ = new BehaviorSubject<PlaybackPayload | null>(null);
  readonly isPlayerOpen$ = new BehaviorSubject<boolean>(false);
  readonly isLive$ = new BehaviorSubject<boolean>(false);

  // Preference for player engine: 'embedded' (default) | 'mpv'
  private readonly PREF_KEY = 'fred_tv_preferred_player';

  constructor(
    private toastr: ToastrService,
    private error: ErrorService
  ) {}

  getPreferredPlayer(): 'embedded' | 'mpv' {
    return (localStorage.getItem(this.PREF_KEY) as 'embedded' | 'mpv') || 'embedded';
  }

  setPreferredPlayer(player: 'embedded' | 'mpv'): void {
    localStorage.setItem(this.PREF_KEY, player);
  }

  /**
   * Universal entry point for playing any Channel
   */
  async playChannel(
    channel: Channel,
    options: {
      type?: PlaybackType;
      title?: string;
      subtitle?: string;
      metadata?: PlaybackMetadata;
      showChannel?: Channel;
      episodesList?: Channel[];
      currentEpisodeIndex?: number;
      channelsList?: Channel[];
      currentChannelIndex?: number;
      enrichedEpisode?: any;
    } = {}
  ): Promise<void> {
    if (!channel || !channel.url) {
      this.toastr.error('Stream URL unavailable for this item');
      return;
    }

    // Determine playback type
    let playbackType: PlaybackType = options.type || 'movie';
    if (channel.media_type === MediaType.livestream) {
      playbackType = 'live';
    } else if (channel.season_id != null || channel.episode_num != null || options.showChannel != null) {
      playbackType = 'episode';
    }

    // Check user preference: if forced to external MPV, launch MPV directly
    if (this.getPreferredPlayer() === 'mpv') {
      await this.launchMpvDirect(channel);
      return;
    }

    // Clean title and subtitle
    const rawTitle = cleanMediaTitle(channel.name || 'Untitled');
    let title = options.title || rawTitle;
    let subtitle = options.subtitle;

    if (playbackType === 'episode') {
      const epNum = options.enrichedEpisode?.episodeNum ?? channel.episode_num ?? 1;
      const seasonNum = options.enrichedEpisode?.seasonNumber ?? channel.season_id ?? 1;
      const epTitle = options.enrichedEpisode?.title || channel.name || `Episode ${epNum}`;
      // Rule: "Show episode number and episode title. Do NOT show the series name in the player header."
      title = `Episode ${epNum} • ${cleanMediaTitle(epTitle)}`;
      subtitle = `Season ${seasonNum}`;
    }

    // Get resume position for VOD
    let initialTime = 0;
    if (playbackType !== 'live' && channel.id != null) {
      initialTime = this.getSavedPlaybackPosition(channel.id);
    }

    const payload: PlaybackPayload = {
      channel,
      playbackType,
      title,
      subtitle,
      metadata: options.metadata,
      initialTime,
      streamUrl: channel.url,
      showChannel: options.showChannel,
      episodesList: options.episodesList,
      currentEpisodeIndex: options.currentEpisodeIndex,
      channelsList: options.channelsList,
      currentChannelIndex: options.currentChannelIndex,
      enrichedEpisode: options.enrichedEpisode,
    };

    // Mark as watched in SQLite
    if (channel.id != null) {
      invoke('add_last_watched', { id: channel.id }).catch(console.error);
    }

    this.isLive$.next(playbackType === 'live');
    this.currentPlayback$.next(payload);
    this.isPlayerOpen$.next(true);
  }

  async playMovie(channel: Channel, metadata?: PlaybackMetadata): Promise<void> {
    await this.playChannel(channel, {
      type: 'movie',
      metadata,
    });
  }

  async playEpisode(
    channel: Channel,
    show: Channel,
    episodesList?: Channel[],
    enrichedEp?: any
  ): Promise<void> {
    const curIndex = episodesList ? episodesList.findIndex((e) => e.id === channel.id) : -1;
    await this.playChannel(channel, {
      type: 'episode',
      showChannel: show,
      episodesList,
      currentEpisodeIndex: curIndex >= 0 ? curIndex : undefined,
      enrichedEpisode: enrichedEp,
    });
  }

  async playLiveChannel(channel: Channel, channelsList?: Channel[]): Promise<void> {
    const curIndex = channelsList ? channelsList.findIndex((c) => c.id === channel.id) : -1;
    await this.playChannel(channel, {
      type: 'live',
      channelsList,
      currentChannelIndex: curIndex >= 0 ? curIndex : undefined,
    });
  }

  async playNextEpisode(): Promise<void> {
    const current = this.currentPlayback$.value;
    if (
      !current ||
      current.playbackType !== 'episode' ||
      !current.episodesList ||
      current.currentEpisodeIndex == null
    ) {
      return;
    }

    const nextIndex = current.currentEpisodeIndex + 1;
    if (nextIndex < current.episodesList.length) {
      const nextEp = current.episodesList[nextIndex];
      await this.playEpisode(nextEp, current.showChannel || nextEp, current.episodesList);
    } else {
      this.toastr.info('You have reached the last episode in this list.');
    }
  }

  async playPreviousEpisode(): Promise<void> {
    const current = this.currentPlayback$.value;
    if (
      !current ||
      current.playbackType !== 'episode' ||
      !current.episodesList ||
      current.currentEpisodeIndex == null
    ) {
      return;
    }

    const prevIndex = current.currentEpisodeIndex - 1;
    if (prevIndex >= 0) {
      const prevEp = current.episodesList[prevIndex];
      await this.playEpisode(prevEp, current.showChannel || prevEp, current.episodesList);
    } else {
      this.toastr.info('This is the first episode.');
    }
  }

  async playNextChannel(): Promise<void> {
    const current = this.currentPlayback$.value;
    if (
      !current ||
      current.playbackType !== 'live' ||
      !current.channelsList ||
      current.currentChannelIndex == null
    ) {
      return;
    }

    const nextIndex = (current.currentChannelIndex + 1) % current.channelsList.length;
    const nextChan = current.channelsList[nextIndex];
    await this.playLiveChannel(nextChan, current.channelsList);
  }

  async playPreviousChannel(): Promise<void> {
    const current = this.currentPlayback$.value;
    if (
      !current ||
      current.playbackType !== 'live' ||
      !current.channelsList ||
      current.currentChannelIndex == null
    ) {
      return;
    }

    const len = current.channelsList.length;
    const prevIndex = (current.currentChannelIndex - 1 + len) % len;
    const prevChan = current.channelsList[prevIndex];
    await this.playLiveChannel(prevChan, current.channelsList);
  }

  closePlayer(): void {
    this.isPlayerOpen$.next(false);
    this.currentPlayback$.next(null);
  }

  /**
   * Automatic Fallback System:
   * When embedded playback fails due to codec, container, or network,
   * gracefully switch to the stable external MPV player.
   */
  async fallbackToMpv(channel: Channel, reason?: string): Promise<void> {
    console.warn('Switching to external MPV fallback:', reason);
    this.closePlayer();

    this.toastr.info(
      reason || 'Embedded playback unavailable. Launching MPV player...',
      'Player Fallback',
      { timeOut: 4500 }
    );

    await this.launchMpvDirect(channel);
  }

  /**
   * User-triggered switch to external MPV player from inside the embedded player.
   */
  async switchToExternalMpv(): Promise<void> {
    const current = this.currentPlayback$.value;
    if (!current || !current.channel) return;

    this.closePlayer();
    this.toastr.info('Switching to external MPV player...');
    await this.launchMpvDirect(current.channel);
  }

  private async launchMpvDirect(channel: Channel): Promise<void> {
    try {
      const playChannel: Channel = {
        ...channel,
        media_type: channel.media_type,
        favorite: !!channel.favorite,
      };
      if (channel.id != null) {
        invoke('add_last_watched', { id: channel.id }).catch(console.error);
      }
      await invoke('play', { channel: playChannel, record: false, recordPath: undefined });
    } catch (e) {
      console.error('MPV playback error:', e);
      this.error.handleError(e);
    }
  }

  savePlaybackPosition(channelId: number, currentTime: number, duration: number): void {
    if (!channelId || isNaN(currentTime) || currentTime < 5) return;

    try {
      localStorage.setItem(`playback_pos_${channelId}`, currentTime.toFixed(1));

      if (duration && duration > 0) {
        const pct = Math.min(100, Math.max(0, (currentTime / duration) * 100));
        localStorage.setItem(`watch_progress_${channelId}`, pct.toFixed(1));

        const storeRaw = localStorage.getItem('fred_tv_watch_progress');
        const store = storeRaw ? JSON.parse(storeRaw) : {};
        store[channelId] = {
          time: Math.round(currentTime),
          duration: Math.round(duration),
          percent: Math.round(pct),
          updated_at: Date.now(),
        };
        localStorage.setItem('fred_tv_watch_progress', JSON.stringify(store));
      }
    } catch (err) {
      console.warn('Failed to save watch progress to localStorage:', err);
    }
  }

  getSavedPlaybackPosition(channelId: number): number {
    try {
      const rawPos = localStorage.getItem(`playback_pos_${channelId}`);
      if (rawPos) {
        const pos = parseFloat(rawPos);
        if (!isNaN(pos) && pos > 10) {
          return pos;
        }
      }
    } catch {
      // ignore
    }
    return 0;
  }
}
