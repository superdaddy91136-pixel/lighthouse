import { Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { BehaviorSubject, Observable } from 'rxjs';
import { Channel } from '../models/channel';

const TV_STORAGE_KEY = 'fred_tv_selected_tv_show';

@Injectable({
  providedIn: 'root',
})
export class TvDetailService {
  private selectedShowSubject = new BehaviorSubject<Channel | undefined>(this.loadStoredShow());
  public selectedShow$: Observable<Channel | undefined> = this.selectedShowSubject.asObservable();

  constructor(private router: Router) {}

  private loadStoredShow(): Channel | undefined {
    try {
      const raw = sessionStorage.getItem(TV_STORAGE_KEY);
      return raw ? JSON.parse(raw) : undefined;
    } catch {
      return undefined;
    }
  }

  public openTvDetail(channel: Channel): void {
    this.selectedShowSubject.next(channel);
    try {
      sessionStorage.setItem(TV_STORAGE_KEY, JSON.stringify(channel));
    } catch (e) {
      console.warn('Failed to save TV show to sessionStorage', e);
    }
    try {
      window.scrollTo(0, 0);
    } catch {}
    this.router.navigate(['tv-detail']);
  }

  public getSelectedShow(): Channel | undefined {
    return this.selectedShowSubject.value || this.loadStoredShow();
  }

  public setSelectedShow(channel?: Channel): void {
    this.selectedShowSubject.next(channel);
    if (channel) {
      try {
        sessionStorage.setItem(TV_STORAGE_KEY, JSON.stringify(channel));
      } catch {}
    } else {
      sessionStorage.removeItem(TV_STORAGE_KEY);
    }
  }
}
