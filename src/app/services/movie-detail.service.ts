import { Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { BehaviorSubject, Observable } from 'rxjs';
import { Channel } from '../models/channel';

const MOVIE_STORAGE_KEY = 'fred_tv_selected_movie';

@Injectable({
  providedIn: 'root',
})
export class MovieDetailService {
  private selectedMovieSubject = new BehaviorSubject<Channel | undefined>(this.loadStoredMovie());
  public selectedMovie$: Observable<Channel | undefined> = this.selectedMovieSubject.asObservable();

  constructor(private router: Router) {}

  private loadStoredMovie(): Channel | undefined {
    try {
      const raw = sessionStorage.getItem(MOVIE_STORAGE_KEY);
      return raw ? JSON.parse(raw) : undefined;
    } catch {
      return undefined;
    }
  }

  public openMovieDetail(channel: Channel): void {
    this.selectedMovieSubject.next(channel);
    try {
      sessionStorage.setItem(MOVIE_STORAGE_KEY, JSON.stringify(channel));
    } catch (e) {
      console.warn('Failed to save movie to sessionStorage', e);
    }
    try {
      window.scrollTo(0, 0);
    } catch {}
    this.router.navigate(['movie-detail']);
  }

  public getSelectedMovie(): Channel | undefined {
    return this.selectedMovieSubject.value || this.loadStoredMovie();
  }

  public setSelectedMovie(channel?: Channel): void {
    this.selectedMovieSubject.next(channel);
    if (channel) {
      try {
        sessionStorage.setItem(MOVIE_STORAGE_KEY, JSON.stringify(channel));
      } catch {}
    } else {
      sessionStorage.removeItem(MOVIE_STORAGE_KEY);
    }
  }
}
