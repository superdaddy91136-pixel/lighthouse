import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root',
})
export class SplashScreenService {
  /** Whether the splash screen overlay is currently visible in the DOM */
  public visible: boolean = true;

  /** Whether the splash screen is currently playing its smooth exit transition */
  public fadingOut: boolean = false;

  /** Maximum duration before safety timeout dismisses splash screen */
  private readonly SAFETY_TIMEOUT_MS = 3500;

  /** Transition duration matching CSS transition (350ms + small buffer) */
  private readonly TRANSITION_DURATION_MS = 380;

  private dismissed: boolean = false;
  private timeoutId: any = null;

  constructor() {
    // Safety timeout ensures user is never stuck on splash screen indefinitely
    this.timeoutId = setTimeout(() => {
      if (!this.dismissed) {
        this.dismiss('safety_timeout');
      }
    }, this.SAFETY_TIMEOUT_MS);
  }

  /**
   * Called as soon as the hero banner has usable TMDB content and artwork prepared.
   */
  public markHeroReady(): void {
    if (this.dismissed || this.fadingOut) return;
    this.dismiss('hero_ready');
  }

  /**
   * Initiates the smooth fade-out transition and removes the splash screen once faded.
   */
  public dismiss(reason: string = 'normal'): void {
    if (this.dismissed) return;
    this.dismissed = true;

    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }

    this.fadingOut = true;

    setTimeout(() => {
      this.visible = false;
      this.fadingOut = false;
    }, this.TRANSITION_DURATION_MS);
  }

  public isDismissed(): boolean {
    return this.dismissed;
  }
}
