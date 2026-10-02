import {
  Component,
  EventEmitter,
  HostListener,
  OnDestroy,
  OnInit,
  Output,
} from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { MemoryService } from '../memory.service';
import { Channel } from '../models/channel';
import { Filters } from '../models/filters';
import { MediaType } from '../models/mediaType';
import { SortType } from '../models/sortType';
import { ViewMode } from '../models/viewMode';

interface ChannelGroup {
  id: number;
  name: string;
}

@Component({
  selector: 'app-channel-switcher',
  templateUrl: './channel-switcher.component.html',
  styleUrl: './channel-switcher.component.css',
})
export class ChannelSwitcherComponent implements OnInit, OnDestroy {
  @Output() switchChannel: EventEmitter<Channel> = new EventEmitter<Channel>();
  @Output() close: EventEmitter<void> = new EventEmitter<void>();

  isOpen = false;
  groups: ChannelGroup[] = [];
  channels: Channel[] = [];
  selectedGroup?: ChannelGroup;
  loading = false;
  searchQuery = '';
  currentChannelId?: number;

  constructor(private memory: MemoryService) {}

  ngOnInit(): void {}

  ngOnDestroy(): void {}

  @HostListener('document:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent): void {
    if (!this.isOpen) return;
    if (event.key === 'Escape') {
      this.toggle();
      event.preventDefault();
      event.stopPropagation();
    }
  }

  async toggle(): Promise<void> {
    this.isOpen = !this.isOpen;
    if (this.isOpen) {
      this.searchQuery = '';
      await this.loadGroups();
    }
  }

  async open(currentChannel?: Channel): Promise<void> {
    this.currentChannelId = currentChannel?.id;
    this.isOpen = true;
    this.searchQuery = '';
    this.selectedGroup = undefined;
    await this.loadGroups();
  }

  closePanel(): void {
    this.isOpen = false;
    this.close.emit();
  }

  async loadGroups(): Promise<void> {
    this.loading = true;
    try {
      const sourceIds = Array.from(this.memory.Sources.keys());
      // Load categories (groups) that contain livestream channels
      const filters: Filters = {
        source_ids: sourceIds,
        media_types: [MediaType.livestream],
        view_type: ViewMode.Categories,
        use_keywords: false,
        page: 1,
        sort: SortType.provider,
      };
      const results = (await invoke('search', { filters })) as Channel[];
      this.groups = (results || [])
        .filter((c) => c.media_type === MediaType.group && c.id != null && c.name)
        .map((c) => ({ id: c.id!, name: c.name! }));

      // If no groups found, fall back to showing all live channels directly
      if (this.groups.length === 0) {
        this.selectedGroup = undefined;
        await this.loadChannels();
      }
    } catch (e) {
      console.error('Failed to load channel groups:', e);
      this.groups = [];
    } finally {
      this.loading = false;
    }
  }

  async selectGroup(group: ChannelGroup): Promise<void> {
    this.selectedGroup = group;
    this.searchQuery = '';
    await this.loadChannels();
  }

  async goBackToGroups(): Promise<void> {
    this.selectedGroup = undefined;
    this.channels = [];
    this.searchQuery = '';
  }

  async loadChannels(): Promise<void> {
    this.loading = true;
    try {
      const sourceIds = Array.from(this.memory.Sources.keys());
      const filters: Filters = {
        source_ids: sourceIds,
        media_types: [MediaType.livestream],
        view_type: ViewMode.All,
        use_keywords: false,
        page: 1,
        sort: SortType.provider,
        group_id: this.selectedGroup?.id,
        query: this.searchQuery?.trim() || undefined,
      };
      const results = (await invoke('search', { filters })) as Channel[];
      this.channels = (results || []).filter(
        (c) => c.media_type === MediaType.livestream && c.url,
      );
    } catch (e) {
      console.error('Failed to load channels:', e);
      this.channels = [];
    } finally {
      this.loading = false;
    }
  }

  async onSearch(): Promise<void> {
    // When searching, bypass category filter to search all live channels
    this.loading = true;
    try {
      const sourceIds = Array.from(this.memory.Sources.keys());
      const filters: Filters = {
        source_ids: sourceIds,
        media_types: [MediaType.livestream],
        view_type: ViewMode.All,
        use_keywords: false,
        page: 1,
        sort: SortType.provider,
        query: this.searchQuery?.trim() || undefined,
      };
      if (!this.selectedGroup && !this.searchQuery?.trim()) {
        // No group selected and no query — show groups
        return;
      }
      if (this.selectedGroup && !this.searchQuery?.trim()) {
        filters.group_id = this.selectedGroup.id;
      }
      const results = (await invoke('search', { filters })) as Channel[];
      this.channels = (results || []).filter(
        (c) => c.media_type === MediaType.livestream && c.url,
      );
    } catch (e) {
      console.error('Failed to search channels:', e);
    } finally {
      this.loading = false;
    }
  }

  selectChannel(channel: Channel): void {
    this.currentChannelId = channel.id;
    this.switchChannel.emit(channel);
    this.isOpen = false;
  }

  isCurrentChannel(channel: Channel): boolean {
    return !!this.currentChannelId && channel.id === this.currentChannelId;
  }

  trackByChannelId(_index: number, channel: Channel): number | undefined {
    return channel.id;
  }

  trackByGroupId(_index: number, group: ChannelGroup): number {
    return group.id;
  }
}
