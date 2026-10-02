import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { TMDB_ENABLED_KEY, TMDB_TOKEN_KEY } from '../models/localStorage';
import { TmdbConfig, TmdbConnectionStatus } from '../models/tmdb';

@Injectable({
  providedIn: 'root',
})
export class TmdbConfigService {
  private configSubject = new BehaviorSubject<TmdbConfig>(this.loadConfig());
  public config$: Observable<TmdbConfig> = this.configSubject.asObservable();

  private statusSubject = new BehaviorSubject<TmdbConnectionStatus>('not_configured');
  public connectionStatus$: Observable<TmdbConnectionStatus> = this.statusSubject.asObservable();

  constructor() {
    this.refreshStatus();
  }

  private loadConfig(): TmdbConfig {
    if (typeof window === 'undefined' || !window.localStorage) {
      return { enabled: false };
    }

    const enabled = localStorage.getItem(TMDB_ENABLED_KEY) === 'true';
    const token = localStorage.getItem(TMDB_TOKEN_KEY) || undefined;

    return { enabled, token };
  }

  public getConfig(): TmdbConfig {
    return this.configSubject.value;
  }

  public isEnabled(): boolean {
    const cfg = this.configSubject.value;
    return cfg.enabled && !!cfg.token && cfg.token.trim().length > 10;
  }

  public getToken(): string | undefined {
    return this.configSubject.value.token;
  }

  public setEnabled(enabled: boolean): void {
    const current = this.configSubject.value;
    localStorage.setItem(TMDB_ENABLED_KEY, String(enabled));
    this.configSubject.next({ ...current, enabled });
    this.refreshStatus();
  }

  public setToken(token?: string): void {
    const current = this.configSubject.value;
    const clean = token?.trim();

    if (clean) {
      localStorage.setItem(TMDB_TOKEN_KEY, clean);
      this.configSubject.next({ ...current, token: clean });
    } else {
      localStorage.removeItem(TMDB_TOKEN_KEY);
      this.configSubject.next({ ...current, token: undefined });
    }
    this.refreshStatus();
  }

  public clearToken(): void {
    localStorage.removeItem(TMDB_TOKEN_KEY);
    const current = this.configSubject.value;
    this.configSubject.next({ ...current, token: undefined });
    this.statusSubject.next('not_configured');
  }

  private refreshStatus(): void {
    const cfg = this.configSubject.value;
    if (!cfg.token || cfg.token.trim().length < 10) {
      this.statusSubject.next('not_configured');
    }
  }

  /**
   * Tests connection to TMDB using the provided token (or stored token).
   * Calls TMDB v3 /authentication endpoint.
   */
  public async testConnection(
    tokenOverride?: string,
  ): Promise<{ success: boolean; message: string; accountName?: string }> {
    const token = (tokenOverride || this.getToken())?.trim();

    if (!token || token.length < 10) {
      this.statusSubject.next('not_configured');
      return { success: false, message: 'Please provide a valid TMDB API Read Access Token.' };
    }

    this.statusSubject.next('testing');

    try {
      const response = await fetch('https://api.themoviedb.org/3/authentication', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      });

      if (response.ok) {
        this.statusSubject.next('connected');
        return {
          success: true,
          message: 'Connection successful! TMDB API is active.',
        };
      }

      if (response.status === 401) {
        this.statusSubject.next('invalid_token');
        return {
          success: false,
          message: 'Invalid API Read Access Token (401 Unauthorized). Please check your token.',
        };
      }

      this.statusSubject.next('error');
      return {
        success: false,
        message: `TMDB returned HTTP error status ${response.status}.`,
      };
    } catch (err: any) {
      this.statusSubject.next('error');
      return {
        success: false,
        message: err?.message ? `Network error: ${err.message}` : 'Failed to reach TMDB API.',
      };
    }
  }
}
