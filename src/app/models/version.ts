import { Channel } from './channel';

export interface MediaVersion {
  channel: Channel;
  sourceName?: string;
  providerPlatform?: string;
  qualityBadge?: string;
  year?: string;
  countryOrLanguage?: string;
  cleanTitle: string;
  rawName: string;
  badgeLabel: string;
  isSelected: boolean;
}
