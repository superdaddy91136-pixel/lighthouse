import { Injectable, NgZone } from '@angular/core';
import { PlaybackTrack } from '../models/playback';
import shaka from 'shaka-player';
import Hls from 'hls.js';

export interface EngineLoadResult {
  engine: 'shaka' | 'hls' | 'native';
  isLive: boolean;
}

@Injectable({
  providedIn: 'root',
})
export class EmbeddedEngineService {
  private shakaPlayer: shaka.Player | null = null;
  private hlsInstance: Hls | null = null;
  private currentEngine: 'shaka' | 'hls' | 'native' | null = null;
  private activeVideoElement: HTMLVideoElement | null = null;
  private polyfillsInstalled = false;

  constructor(private ngZone: NgZone) {
    this.initPolyfills();
  }

  private initPolyfills(): void {
    if (!this.polyfillsInstalled && typeof window !== 'undefined') {
      try {
        shaka.polyfill.installAll();
        this.polyfillsInstalled = true;
      } catch (err) {
        console.warn('Failed to install Shaka polyfills:', err);
      }
    }
  }

  async loadStream(
    videoElement: HTMLVideoElement,
    url: string,
    startTime: number = 0,
    isLiveHint: boolean = false
  ): Promise<EngineLoadResult> {
    await this.destroyCurrent();
    this.activeVideoElement = videoElement;

    // Normalize URL
    const cleanUrl = url.trim();
    const isHls = cleanUrl.includes('.m3u8');
    const isDirectMp4 = cleanUrl.includes('.mp4') || cleanUrl.includes('.webm') || cleanUrl.includes('.mkv');

    // 1. Primary Engine: Shaka Player
    if (shaka.Player.isBrowserSupported()) {
      try {
        const result = await this.tryShakaPlayer(videoElement, cleanUrl, startTime, isLiveHint);
        this.currentEngine = 'shaka';
        return result;
      } catch (shakaErr) {
        console.warn('Shaka Player failed to load stream, attempting secondary engine:', shakaErr);
        await this.destroyShaka();
      }
    }

    // 2. Secondary Engine: HLS.js (for HLS / .m3u8 streams)
    if ((isHls || !isDirectMp4) && Hls.isSupported()) {
      try {
        const result = await this.tryHlsJs(videoElement, cleanUrl, startTime, isLiveHint);
        this.currentEngine = 'hls';
        return result;
      } catch (hlsErr) {
        console.warn('HLS.js failed to load stream, attempting native video fallback:', hlsErr);
        this.destroyHls();
      }
    }

    // 3. Tertiary Engine: Native HTML5 Video Element
    try {
      const result = await this.tryNativeVideo(videoElement, cleanUrl, startTime, isLiveHint);
      this.currentEngine = 'native';
      return result;
    } catch (nativeErr) {
      console.error('All embedded player engines failed for URL:', cleanUrl, nativeErr);
      await this.destroyCurrent();
      throw new Error(`Embedded playback engine unsupported for stream format: ${cleanUrl}`);
    }
  }

  private async tryShakaPlayer(
    videoElement: HTMLVideoElement,
    url: string,
    startTime: number,
    isLiveHint: boolean
  ): Promise<EngineLoadResult> {
    const player = new shaka.Player();
    await player.attach(videoElement);

    player.configure({
      streaming: {
        lowLatencyMode: isLiveHint,
        rebufferingGoal: 2,
        bufferingGoal: isLiveHint ? 8 : 25,
        bufferBehind: 15,
        stallEnabled: true,
        stallThreshold: 2,
        retryParameters: {
          maxAttempts: 3,
          baseDelay: 1000,
          backoffFactor: 1.5,
          fuzzFactor: 0.2,
          timeout: 12000,
        },
      },
      manifest: {
        retryParameters: {
          maxAttempts: 3,
          baseDelay: 1000,
          backoffFactor: 1.5,
          fuzzFactor: 0.2,
          timeout: 12000,
        },
      },
    });

    this.shakaPlayer = player;

    const startPos = startTime > 5 ? startTime : null;
    await player.load(url, startPos);

    const isLive = player.isLive();
    return { engine: 'shaka', isLive };
  }

  private async tryHlsJs(
    videoElement: HTMLVideoElement,
    url: string,
    startTime: number,
    isLiveHint: boolean
  ): Promise<EngineLoadResult> {
    return new Promise<EngineLoadResult>((resolve, reject) => {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: isLiveHint,
        backBufferLength: 30,
        maxBufferLength: isLiveHint ? 10 : 30,
        maxMaxBufferLength: 60,
      });

      let resolved = false;
      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          hls.destroy();
          reject(new Error('HLS.js load timeout'));
        }
      }, 15000);

      hls.on(Hls.Events.MEDIA_ATTACHED, () => {
        hls.loadSource(url);
      });

      hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          this.hlsInstance = hls;

          if (startTime > 5 && !data.levels?.[0]?.details?.live) {
            videoElement.currentTime = startTime;
          }

          const isLive = !!data.levels?.[0]?.details?.live || isLiveHint;
          resolve({ engine: 'hls', isLive });
        }
      });

      hls.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeoutId);
            hls.destroy();
            reject(data);
          } else {
            switch (data.type) {
              case Hls.ErrorTypes.NETWORK_ERROR:
                console.warn('HLS.js fatal network error encountered, attempting recovery...');
                hls.startLoad();
                break;
              case Hls.ErrorTypes.MEDIA_ERROR:
                console.warn('HLS.js fatal media error encountered, recovering...');
                hls.recoverMediaError();
                break;
              default:
                console.error('HLS.js unrecoverable fatal error:', data);
                hls.destroy();
                this.hlsInstance = null;
                break;
            }
          }
        }
      });

      hls.attachMedia(videoElement);
    });
  }

  private async tryNativeVideo(
    videoElement: HTMLVideoElement,
    url: string,
    startTime: number,
    isLiveHint: boolean
  ): Promise<EngineLoadResult> {
    return new Promise<EngineLoadResult>((resolve, reject) => {
      let resolved = false;
      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanup();
          reject(new Error('Native HTML5 video load timeout'));
        }
      }, 12000);

      const onLoadedMetadata = () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          cleanup();

          if (startTime > 5 && isFinite(videoElement.duration)) {
            videoElement.currentTime = startTime;
          }

          const isLive = !isFinite(videoElement.duration) || isLiveHint;
          resolve({ engine: 'native', isLive });
        }
      };

      const onError = () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          cleanup();
          reject(videoElement.error || new Error('Native video playback error'));
        }
      };

      const cleanup = () => {
        videoElement.removeEventListener('loadedmetadata', onLoadedMetadata);
        videoElement.removeEventListener('error', onError);
      };

      videoElement.addEventListener('loadedmetadata', onLoadedMetadata);
      videoElement.addEventListener('error', onError);
      videoElement.src = url;
      videoElement.load();
    });
  }

  getAudioTracks(): PlaybackTrack[] {
    const tracks: PlaybackTrack[] = [];

    if (this.currentEngine === 'shaka' && this.shakaPlayer) {
      try {
        const variants = this.shakaPlayer.getVariantTracks() || [];
        const seenLanguages = new Set<string>();

        variants.forEach((v: shaka.extern.Track) => {
          const lang = v.language || 'Unknown';
          const label = v.label || `${lang.toUpperCase()}${v.channelsCount ? ` (${v.channelsCount}ch)` : ''}`;
          const key = `${lang}_${v.channelsCount || 0}`;

          if (!seenLanguages.has(key)) {
            seenLanguages.add(key);
            tracks.push({
              id: v.id,
              label: label,
              language: lang,
              active: !!v.active,
              kind: 'audio',
            });
          }
        });
      } catch (err) {
        console.warn('Failed to retrieve Shaka audio tracks:', err);
      }
    } else if (this.currentEngine === 'hls' && this.hlsInstance) {
      try {
        const audioTracks = this.hlsInstance.audioTracks || [];
        const currentId = this.hlsInstance.audioTrack;
        audioTracks.forEach((t, idx) => {
          tracks.push({
            id: idx,
            label: t.name || t.lang || `Track ${idx + 1}`,
            language: t.lang,
            active: idx === currentId,
            kind: 'audio',
          });
        });
      } catch (err) {
        console.warn('Failed to retrieve HLS audio tracks:', err);
      }
    }

    return tracks;
  }

  selectAudioTrack(trackId: number | string): void {
    if (this.currentEngine === 'shaka' && this.shakaPlayer) {
      try {
        const variants = this.shakaPlayer.getVariantTracks() || [];
        const target = variants.find((v: shaka.extern.Track) => v.id === trackId);
        if (target) {
          this.shakaPlayer.selectVariantTrack(target, /* clearBuffer= */ true);
        }
      } catch (err) {
        console.warn('Failed to select Shaka audio track:', err);
      }
    } else if (this.currentEngine === 'hls' && this.hlsInstance) {
      try {
        this.hlsInstance.audioTrack = Number(trackId);
      } catch (err) {
        console.warn('Failed to select HLS audio track:', err);
      }
    }
  }

  getSubtitleTracks(): PlaybackTrack[] {
    const tracks: PlaybackTrack[] = [];

    if (this.currentEngine === 'shaka' && this.shakaPlayer) {
      try {
        const textTracks: shaka.extern.TextTrack[] = this.shakaPlayer.getTextTracks() || [];

        textTracks.forEach((t: shaka.extern.TextTrack) => {
          tracks.push({
            id: t.id,
            label: t.label || t.language?.toUpperCase() || 'Subtitles',
            language: t.language,
            active: !!t.active,
            kind: 'subtitle',
          });
        });
      } catch (err) {
        console.warn('Failed to retrieve Shaka text tracks:', err);
      }
    } else if (this.currentEngine === 'hls' && this.hlsInstance) {
      try {
        const subs = this.hlsInstance.subtitleTracks || [];
        const currentId = this.hlsInstance.subtitleTrack;
        subs.forEach((t, idx) => {
          tracks.push({
            id: idx,
            label: t.name || t.lang || `Subtitles ${idx + 1}`,
            language: t.lang,
            active: idx === currentId,
            kind: 'subtitle',
          });
        });
      } catch (err) {
        console.warn('Failed to retrieve HLS subtitle tracks:', err);
      }
    }

    return tracks;
  }

  selectSubtitleTrack(trackId: number | string | null): void {
    if (this.currentEngine === 'shaka' && this.shakaPlayer) {
      try {
        if (trackId === null) {
          this.shakaPlayer.selectTextTrack(null);
        } else {
          const textTracks = this.shakaPlayer.getTextTracks() || [];
          const target = textTracks.find((t: shaka.extern.TextTrack) => t.id === trackId);
          if (target) {
            this.shakaPlayer.selectTextTrack(target);
          }
        }
      } catch (err) {
        console.warn('Failed to set Shaka text track:', err);
      }
    } else if (this.currentEngine === 'hls' && this.hlsInstance) {
      try {
        this.hlsInstance.subtitleTrack = trackId === null ? -1 : Number(trackId);
      } catch (err) {
        console.warn('Failed to set HLS subtitle track:', err);
      }
    }
  }

  jumpToLiveEdge(): void {
    if (!this.activeVideoElement) return;

    if (this.currentEngine === 'shaka' && this.shakaPlayer) {
      try {
        const seekRange = this.shakaPlayer.seekRange();
        if (seekRange && isFinite(seekRange.end)) {
          this.activeVideoElement.currentTime = Math.max(0, seekRange.end - 1);
        }
      } catch (err) {
        console.warn('Failed to jump to Shaka live edge:', err);
      }
    } else if (this.currentEngine === 'hls' && this.hlsInstance) {
      try {
        if (this.hlsInstance.liveSyncPosition) {
          this.activeVideoElement.currentTime = this.hlsInstance.liveSyncPosition;
        } else if (isFinite(this.activeVideoElement.duration)) {
          this.activeVideoElement.currentTime = this.activeVideoElement.duration;
        }
      } catch (err) {
        console.warn('Failed to jump to HLS live edge:', err);
      }
    } else if (isFinite(this.activeVideoElement.duration)) {
      this.activeVideoElement.currentTime = this.activeVideoElement.duration;
    }
  }

  isLiveStream(): boolean {
    if (this.currentEngine === 'shaka' && this.shakaPlayer) {
      return this.shakaPlayer.isLive();
    }
    if (this.currentEngine === 'hls' && this.hlsInstance) {
      return !!this.hlsInstance.levels?.[this.hlsInstance.currentLevel]?.details?.live;
    }
    if (this.activeVideoElement) {
      return !isFinite(this.activeVideoElement.duration);
    }
    return false;
  }

  private async destroyShaka(): Promise<void> {
    if (this.shakaPlayer) {
      try {
        await this.shakaPlayer.destroy();
      } catch (e) {
        console.warn('Error destroying Shaka player:', e);
      }
      this.shakaPlayer = null;
    }
  }

  private destroyHls(): void {
    if (this.hlsInstance) {
      try {
        this.hlsInstance.destroy();
      } catch (e) {
        console.warn('Error destroying HLS.js instance:', e);
      }
      this.hlsInstance = null;
    }
  }

  async destroyCurrent(): Promise<void> {
    await this.destroyShaka();
    this.destroyHls();

    if (this.activeVideoElement) {
      try {
        this.activeVideoElement.pause();
        this.activeVideoElement.removeAttribute('src');
        this.activeVideoElement.load();
      } catch (e) {
        // ignore
      }
      this.activeVideoElement = null;
    }
    this.currentEngine = null;
  }
}
