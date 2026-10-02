import { Channel } from './channel';

export type PlaybackType = 'movie' | 'episode' | 'live';

export type PlayerState = 'idle' | 'loading' | 'playing' | 'paused' | 'buffering' | 'ended' | 'error';

export interface PlaybackMetadata {
  year?: string | number;
  rating?: string;
  duration?: string;
  quality?: string;
  genre?: string;
}

export interface PlaybackTrack {
  id: number | string;
  label: string;
  language?: string;
  active: boolean;
  kind?: 'audio' | 'subtitle';
}

export interface PlaybackPayload {
  channel: Channel;
  playbackType: PlaybackType;
  title: string;
  subtitle?: string; // For episode: "S1:E3 • Title"
  metadata?: PlaybackMetadata;
  initialTime?: number;
  streamUrl: string;
  showChannel?: Channel; // Parent show for TV series
  episodesList?: Channel[]; // Full episode list for next/prev
  currentEpisodeIndex?: number;
  channelsList?: Channel[]; // Full channel list for Live TV next/prev
  currentChannelIndex?: number;
  enrichedEpisode?: any;
}
