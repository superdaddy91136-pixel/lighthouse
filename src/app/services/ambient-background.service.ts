import { Injectable, NgZone } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

export interface AmbientPalette {
  primary: RgbColor;
  secondary: RgbColor;
  tertiary: RgbColor;
  base: string;
  sourceUrl?: string;
  isDefault?: boolean;
}

export const DEFAULT_FALLBACK_PALETTE: AmbientPalette = {
  primary: { r: 24, g: 32, b: 46 },    // Elegant deep slate-navy
  secondary: { r: 18, g: 24, b: 36 },  // Deep indigo charcoal
  tertiary: { r: 14, g: 18, b: 26 },   // Subtle obsidian dusk
  base: '#07080c',
  isDefault: true,
};

interface ColorBucket {
  count: number;
  rSum: number;
  gSum: number;
  bSum: number;
  sSum: number;
  lSum: number;
}

@Injectable({
  providedIn: 'root',
})
export class AmbientBackgroundService {
  private currentRequestId = 0;
  private activeArtworkUrl?: string;
  private lastHomeHeroArtwork?: string;

  // Capped in-memory palette cache
  private readonly paletteCache = new Map<string, AmbientPalette>();
  private readonly MAX_CACHE_ENTRIES = 120;

  private readonly paletteSubject = new BehaviorSubject<AmbientPalette>(DEFAULT_FALLBACK_PALETTE);
  public readonly currentPalette$: Observable<AmbientPalette> = this.paletteSubject.asObservable();

  constructor(private ngZone: NgZone) {}

  /**
   * Sets active artwork for the ambient background.
   * If URL is in cache, immediately applies cached palette.
   * Otherwise, extracts colors asynchronously while preserving previous palette to avoid flashing.
   */
  public setArtwork(url: string | undefined | null, sourceId?: string): void {
    const trimmed = url?.trim();

    if (sourceId === 'home-hero' && trimmed) {
      this.lastHomeHeroArtwork = trimmed;
    }

    if (!trimmed) {
      this.resetToDefault(sourceId);
      return;
    }

    if (this.activeArtworkUrl === trimmed) {
      // Artwork already active
      return;
    }

    this.activeArtworkUrl = trimmed;
    const requestId = ++this.currentRequestId;

    // Check cache first for instant synchronous update
    if (this.paletteCache.has(trimmed)) {
      const cached = this.paletteCache.get(trimmed)!;
      this.paletteSubject.next(cached);
      return;
    }

    // Run extraction outside Angular zone to prevent unneeded change detection cycles during decoding
    this.ngZone.runOutsideAngular(() => {
      this.extractPaletteFromUrl(trimmed)
        .then((palette) => {
          // Cache extracted result regardless of whether request was superseded
          this.cachePalette(trimmed, palette);

          // Discard if user already navigated to different artwork
          if (requestId !== this.currentRequestId || this.activeArtworkUrl !== trimmed) {
            return;
          }

          // Apply new palette inside Angular zone
          this.ngZone.run(() => {
            this.paletteSubject.next(palette);
          });
        })
        .catch(() => {
          if (requestId === this.currentRequestId) {
            this.ngZone.run(() => {
              this.paletteSubject.next(DEFAULT_FALLBACK_PALETTE);
            });
          }
        });
    });
  }

  /**
   * Resets background to the intentional dark-gradient fallback.
   */
  public resetToDefault(sourceId?: string): void {
    this.currentRequestId++;
    this.activeArtworkUrl = undefined;
    if (this.paletteSubject.value !== DEFAULT_FALLBACK_PALETTE) {
      this.paletteSubject.next(DEFAULT_FALLBACK_PALETTE);
    }
  }

  /**
   * Restores the last active Home hero backdrop palette if known.
   */
  public restoreHomeHero(): void {
    if (this.lastHomeHeroArtwork) {
      this.setArtwork(this.lastHomeHeroArtwork, 'home-hero');
    } else {
      this.resetToDefault('home-restore');
    }
  }

  public getCurrentPalette(): AmbientPalette {
    return this.paletteSubject.value;
  }

  private cachePalette(url: string, palette: AmbientPalette): void {
    if (this.paletteCache.size >= this.MAX_CACHE_ENTRIES) {
      // Evict oldest entry
      const oldestKey = this.paletteCache.keys().next().value;
      if (oldestKey) {
        this.paletteCache.delete(oldestKey);
      }
    }
    this.paletteCache.set(url, palette);
  }

  /**
   * Loads image via offscreen canvas and extracts dominant color palette.
   * Handles CORS restrictions, network timeouts, invalid images safely.
   */
  private extractPaletteFromUrl(url: string): Promise<AmbientPalette> {
    return new Promise<AmbientPalette>((resolve) => {
      const img = new Image();
      let isDone = false;

      // Hard timeout after 3500ms to avoid hanging on slow network requests
      const timer = setTimeout(() => {
        if (!isDone) {
          isDone = true;
          img.src = '';
          resolve(DEFAULT_FALLBACK_PALETTE);
        }
      }, 3500);

      const cleanup = () => {
        clearTimeout(timer);
        isDone = true;
      };

      img.crossOrigin = 'anonymous';

      img.onload = () => {
        if (isDone) return;
        cleanup();

        try {
          const w = 48;
          const h = 27; // 16:9 ratio, only 1,296 pixels
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;

          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (!ctx) {
            resolve(DEFAULT_FALLBACK_PALETTE);
            return;
          }

          ctx.drawImage(img, 0, 0, w, h);
          const imgData = ctx.getImageData(0, 0, w, h);
          const palette = this.computePaletteFromPixels(imgData.data, url);
          resolve(palette);
        } catch {
          // CORS security error or decode failure: gracefully fallback
          resolve(DEFAULT_FALLBACK_PALETTE);
        }
      };

      img.onerror = () => {
        if (isDone) return;
        cleanup();
        resolve(DEFAULT_FALLBACK_PALETTE);
      };

      img.src = url;
    });
  }

  /**
   * Processes raw RGBA pixel data to find vibrant, atmospheric primary, secondary, and tertiary colors.
   */
  private computePaletteFromPixels(data: Uint8ClampedArray, sourceUrl: string): AmbientPalette {
    const buckets = new Map<string, ColorBucket>();
    let totalEligible = 0;
    let fallbackR = 0, fallbackG = 0, fallbackB = 0;
    let fallbackCount = 0;

    const totalPixels = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];

      if (a < 128) continue;

      const [h, s, l] = this.rgbToHsl(r, g, b);

      fallbackR += r;
      fallbackG += g;
      fallbackB += b;
      fallbackCount++;

      // Filter out pure black/shadows and blown-out whites/glare
      if (l < 0.12 || l > 0.88) continue;

      // Filter out muddy, low-saturation greys unless monochrome
      if (s < 0.15) continue;

      // Quantize to 32-step buckets (8 levels per channel = 512 max buckets)
      const qr = Math.floor(r / 32) * 32;
      const qg = Math.floor(g / 32) * 32;
      const qb = Math.floor(b / 32) * 32;
      const key = `${qr},${qg},${qb}`;

      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { count: 0, rSum: 0, gSum: 0, bSum: 0, sSum: 0, lSum: 0 };
        buckets.set(key, bucket);
      }

      bucket.count++;
      bucket.rSum += r;
      bucket.gSum += g;
      bucket.bSum += b;
      bucket.sSum += s;
      bucket.lSum += l;
      totalEligible++;
    }

    // If artwork is monochrome / black & white, buckets with s >= 0.15 might be empty
    if (totalEligible < 25 && fallbackCount > 0) {
      const avgR = Math.round(fallbackR / fallbackCount);
      const avgG = Math.round(fallbackG / fallbackCount);
      const avgB = Math.round(fallbackB / fallbackCount);
      // Elegant cool monochrome cinematic palette
      return {
        primary: this.tuneColor({ r: avgR + 8, g: avgG + 14, b: avgB + 22 }, 0.28, 0.28),
        secondary: this.tuneColor({ r: avgR, g: avgG + 6, b: avgB + 14 }, 0.22, 0.22),
        tertiary: this.tuneColor({ r: avgR - 6, g: avgG, b: avgB + 8 }, 0.16, 0.16),
        base: '#07080c',
        sourceUrl,
      };
    }

    // Score buckets: favor vibrant saturation and pleasing mid-luminance
    const scoredList: { r: number; g: number; b: number; s: number; l: number; score: number }[] = [];

    buckets.forEach((b) => {
      const avgR = b.rSum / b.count;
      const avgG = b.gSum / b.count;
      const avgB = b.bSum / b.count;
      const avgS = b.sSum / b.count;
      const avgL = b.lSum / b.count;

      // Score: high saturation boosted, mid-tones (L ~ 0.45) preferred over extreme dark/bright
      const lumScore = 1 - Math.abs(avgL - 0.45) * 0.7;
      const satScore = 0.35 + avgS * 0.65;
      const score = b.count * satScore * lumScore;

      scoredList.push({ r: avgR, g: avgG, b: avgB, s: avgS, l: avgL, score });
    });

    scoredList.sort((a, b) => b.score - a.score);

    if (scoredList.length === 0) {
      return DEFAULT_FALLBACK_PALETTE;
    }

    // Primary: top scoring candidate
    const top = scoredList[0];
    const primary = this.tuneColor({ r: top.r, g: top.g, b: top.b }, 0.55, 0.32);

    // Secondary: highest-scoring candidate distinct from primary
    let secondaryCandidate = scoredList.find((item) => this.colorDistance(primary, item) >= 60);
    let secondary: RgbColor;

    if (secondaryCandidate) {
      secondary = this.tuneColor(
        { r: secondaryCandidate.r, g: secondaryCandidate.g, b: secondaryCandidate.b },
        0.50,
        0.26
      );
    } else {
      // Harmonic hue shift if single dominant hue in artwork
      secondary = this.generateHarmonicColor(primary, 35, 0.24);
    }

    // Tertiary: candidate distinct from both primary and secondary
    let tertiaryCandidate = scoredList.find(
      (item) => this.colorDistance(primary, item) >= 45 && this.colorDistance(secondary, item) >= 45
    );
    let tertiary: RgbColor;

    if (tertiaryCandidate) {
      tertiary = this.tuneColor(
        { r: tertiaryCandidate.r, g: tertiaryCandidate.g, b: tertiaryCandidate.b },
        0.42,
        0.18
      );
    } else {
      tertiary = this.generateHarmonicColor(primary, -40, 0.18);
    }

    return {
      primary,
      secondary,
      tertiary,
      base: '#07080c',
      sourceUrl,
      isDefault: false,
    };
  }

  /**
   * Clamps color saturation and luminance for atmospheric ambient lighting:
   * Keeps it rich and atmospheric, avoiding washed-out greys and blinding neon lights.
   */
  private tuneColor(c: RgbColor, targetSat: number, targetLum: number): RgbColor {
    const [h, s, l] = this.rgbToHsl(c.r, c.g, c.b);
    const clampedS = Math.min(0.68, Math.max(0.35, s > 0.1 ? s : targetSat));
    const clampedL = Math.min(0.38, Math.max(0.20, targetLum));
    return this.hslToRgb(h, clampedS, clampedL);
  }

  private generateHarmonicColor(base: RgbColor, hueShiftDeg: number, targetLum: number): RgbColor {
    const [h, s, _] = this.rgbToHsl(base.r, base.g, base.b);
    const newHue = (h + hueShiftDeg / 360 + 1) % 1;
    return this.hslToRgb(newHue, Math.min(0.60, Math.max(0.35, s)), targetLum);
  }

  private colorDistance(c1: RgbColor, c2: { r: number; g: number; b: number }): number {
    const dr = c1.r - c2.r;
    const dg = c1.g - c2.g;
    const db = c1.b - c2.b;
    return Math.sqrt(dr * dr + dg * dg + db * db);
  }

  private rgbToHsl(r: number, g: number, b: number): [number, number, number] {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h = 0;
    let s = 0;
    const l = (max + min) / 2;

    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r:
          h = (g - b) / d + (g < b ? 6 : 0);
          break;
        case g:
          h = (b - r) / d + 2;
          break;
        case b:
          h = (r - g) / d + 4;
          break;
      }
      h /= 6;
    }

    return [h, s, l];
  }

  private hslToRgb(h: number, s: number, l: number): RgbColor {
    let r: number, g: number, b: number;

    if (s === 0) {
      r = g = b = l;
    } else {
      const hue2rgb = (p: number, q: number, t: number) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };

      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1 / 3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1 / 3);
    }

    return {
      r: Math.round(r * 255),
      g: Math.round(g * 255),
      b: Math.round(b * 255),
    };
  }
}
