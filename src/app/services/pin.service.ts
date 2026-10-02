import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { Channel } from '../models/channel';
import { MediaType } from '../models/mediaType';
import { NavTab } from '../models/navTab';

export interface PinnedItem {
  key: string;
  id: number;
  name: string;
  media_type: MediaType;
  source_id?: number;
  series_id?: number;
  group_id?: number;
  tab: NavTab; // NavTab.LiveTV, NavTab.Movies, or NavTab.TVShows
  isGroup: boolean;
  channel: Channel;
  pinnedAt: number;
}

const PINNED_STORAGE_KEY = 'fred_tv_pinned_items_v1';

@Injectable({
  providedIn: 'root',
})
export class PinService {
  private pinnedItemsSubject = new BehaviorSubject<PinnedItem[]>(this.loadFromStorage());
  public pinnedItems$: Observable<PinnedItem[]> = this.pinnedItemsSubject.asObservable();

  constructor() {}

  /**
   * Loads and validates stored pinned items from localStorage.
   */
  private loadFromStorage(): PinnedItem[] {
    try {
      const raw = localStorage.getItem(PINNED_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];

      const validItems: PinnedItem[] = [];
      for (const item of parsed) {
        if (
          item &&
          item.id != null &&
          item.name &&
          item.media_type != null &&
          item.tab &&
          item.channel
        ) {
          validItems.push({
            key: item.key || this.generateKey(item.channel, item.tab),
            id: Number(item.id),
            name: String(item.name),
            media_type: Number(item.media_type) as MediaType,
            source_id: item.source_id != null ? Number(item.source_id) : undefined,
            series_id: item.series_id != null ? Number(item.series_id) : undefined,
            group_id: item.group_id != null ? Number(item.group_id) : undefined,
            tab: item.tab,
            isGroup: !!item.isGroup || item.media_type === MediaType.group,
            channel: item.channel,
            pinnedAt: item.pinnedAt || Date.now(),
          });
        }
      }
      return validItems;
    } catch (e) {
      console.warn('Failed to load pinned items from storage:', e);
      return [];
    }
  }

  /**
   * Persists items to localStorage and emits update.
   */
  private saveToStorage(items: PinnedItem[]): void {
    try {
      localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(items));
    } catch (e) {
      console.warn('Failed to persist pinned items to localStorage:', e);
    }
    this.pinnedItemsSubject.next([...items]);
  }

  /**
   * Resolves which catalog tab an item/folder belongs to.
   */
  getTabForChannel(channel: Channel, activeTab: NavTab): NavTab {
    if (channel.media_type === MediaType.livestream) {
      return NavTab.LiveTV;
    }
    if (channel.media_type === MediaType.movie) {
      return NavTab.Movies;
    }
    if (channel.media_type === MediaType.serie) {
      return NavTab.TVShows;
    }
    if (channel.media_type === MediaType.group) {
      if (
        activeTab === NavTab.LiveTV ||
        activeTab === NavTab.Movies ||
        activeTab === NavTab.TVShows
      ) {
        return activeTab;
      }
    }
    return activeTab;
  }

  /**
   * Generates a stable unique key for a channel/group.
   */
  generateKey(channel: Channel, tab: NavTab): string {
    const isGroup = channel.media_type === MediaType.group;
    const cleanName = (channel.name || '').trim().toLowerCase();
    const sourceId = channel.source_id ?? 0;
    const id = channel.id ?? 0;
    const type = channel.media_type ?? (isGroup ? MediaType.group : MediaType.livestream);

    if (isGroup) {
      return `group_${tab}_${sourceId}_${id}_${cleanName}`;
    }
    return `item_${type}_${sourceId}_${id}_${cleanName}`;
  }

  /**
   * Checks whether a channel/group is currently pinned.
   */
  isPinned(channel: Channel, tab?: NavTab): boolean {
    if (!channel || channel.id == null) return false;
    const current = this.pinnedItemsSubject.value;
    const isGroup = channel.media_type === MediaType.group;
    const cleanName = (channel.name || '').trim().toLowerCase();
    const resolvedTab = tab ? this.getTabForChannel(channel, tab) : undefined;

    return current.some((p) => {
      // Direct ID match
      if (p.id === channel.id && p.media_type === channel.media_type) {
        if (p.source_id != null && channel.source_id != null) {
          if (p.source_id === channel.source_id) {
            return resolvedTab ? p.tab === resolvedTab : true;
          }
        } else {
          return resolvedTab ? p.tab === resolvedTab : true;
        }
      }
      // For groups: match name and tab if ID shifted across provider refresh
      if (isGroup && p.isGroup && p.name.trim().toLowerCase() === cleanName) {
        if (resolvedTab) {
          return p.tab === resolvedTab;
        }
        return true;
      }
      return false;
    });
  }

  /**
   * Pins an item/folder.
   */
  pin(channel: Channel, tab: NavTab): void {
    if (!channel || channel.id == null) return;
    const current = this.pinnedItemsSubject.value;
    const resolvedTab = this.getTabForChannel(channel, tab);

    if (this.isPinned(channel, resolvedTab)) {
      return; // Already pinned
    }

    const isGroup = channel.media_type === MediaType.group;
    const key = this.generateKey(channel, resolvedTab);

    // Deep copy channel to preserve all metadata
    const channelCopy: Channel = {
      id: channel.id,
      name: channel.name,
      group_id: channel.group_id,
      image: channel.image,
      url: channel.url,
      media_type: channel.media_type ?? (isGroup ? MediaType.group : MediaType.livestream),
      source_id: channel.source_id,
      series_id: channel.series_id,
      season_id: channel.season_id,
      episode_num: channel.episode_num,
      favorite: channel.favorite,
      stream_id: channel.stream_id,
      tv_archive: channel.tv_archive,
      hidden: channel.hidden,
    };

    const newItem: PinnedItem = {
      key,
      id: channel.id,
      name: channel.name || '',
      media_type: channelCopy.media_type!,
      source_id: channel.source_id,
      series_id: channel.series_id,
      group_id: channel.group_id,
      tab: resolvedTab,
      isGroup,
      channel: channelCopy,
      pinnedAt: Date.now(),
    };

    this.saveToStorage([newItem, ...current]);
  }

  /**
   * Unpins an item/folder.
   */
  unpin(channel: Channel, tab?: NavTab): void {
    if (!channel || channel.id == null) return;
    const current = this.pinnedItemsSubject.value;
    const isGroup = channel.media_type === MediaType.group;
    const cleanName = (channel.name || '').trim().toLowerCase();
    const resolvedTab = tab ? this.getTabForChannel(channel, tab) : undefined;

    const filtered = current.filter((p) => {
      if (p.id === channel.id && p.media_type === channel.media_type) {
        if (p.source_id != null && channel.source_id != null) {
          if (p.source_id === channel.source_id) {
            return resolvedTab ? p.tab !== resolvedTab : false;
          }
        } else {
          return resolvedTab ? p.tab !== resolvedTab : false;
        }
      }
      if (isGroup && p.isGroup && p.name.trim().toLowerCase() === cleanName) {
        if (resolvedTab) {
          return p.tab !== resolvedTab;
        }
        return false;
      }
      return true;
    });

    this.saveToStorage(filtered);
  }

  /**
   * Toggles pin status. Returns true if pinned, false if unpinned.
   */
  togglePin(channel: Channel, tab: NavTab): boolean {
    const resolvedTab = this.getTabForChannel(channel, tab);
    if (this.isPinned(channel, resolvedTab)) {
      this.unpin(channel, resolvedTab);
      return false;
    } else {
      this.pin(channel, resolvedTab);
      return true;
    }
  }

  /**
   * Retrieves pinned Channel objects for a specific catalog tab.
   * Pinned folders (categories) are ordered FIRST, followed by media items.
   * If groupId is provided, returns pinned items inside that category.
   */
  getPinnedChannelsForTab(tab: NavTab, groupId?: number): Channel[] {
    const all = this.pinnedItemsSubject.value;
    const forTab = all.filter((item) => item.tab === tab);

    let candidates: PinnedItem[];
    if (groupId != null) {
      // Inside a folder: return pinned items belonging to this folder
      candidates = forTab.filter(
        (item) => !item.isGroup && item.group_id === groupId
      );
    } else {
      // Top level of tab: return all pinned items for this tab
      candidates = forTab;
    }

    // Separate folders and items
    const folders = candidates.filter((item) => item.isGroup);
    const mediaItems = candidates.filter((item) => !item.isGroup);

    // Sort folders alphabetically
    folders.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    // Sort media items alphabetically
    mediaItems.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    // Pinned folders appear before items
    const ordered = [...folders, ...mediaItems];
    return ordered.map((item) => item.channel);
  }
}
