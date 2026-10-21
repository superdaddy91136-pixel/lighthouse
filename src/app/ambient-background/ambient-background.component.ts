import {
  Component,
  OnInit,
  AfterViewInit,
  OnDestroy,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  ViewChild,
  ElementRef,
} from '@angular/core';
import { Subscription } from 'rxjs';
import {
  AmbientBackgroundService,
  AmbientPalette,
  DEFAULT_FALLBACK_PALETTE,
} from '../services/ambient-background.service';

@Component({
  selector: 'app-ambient-background',
  templateUrl: './ambient-background.component.html',
  styleUrls: ['./ambient-background.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AmbientBackgroundComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('stageA', { static: false }) stageA?: ElementRef<HTMLDivElement>;
  @ViewChild('stageB', { static: false }) stageB?: ElementRef<HTMLDivElement>;

  public activeLayer: 'A' | 'B' = 'A';
  private isInitialized = false;
  private pendingPalette: AmbientPalette = DEFAULT_FALLBACK_PALETTE;
  private currentPaletteKey = '';
  private sub?: Subscription;

  constructor(
    private ambientService: AmbientBackgroundService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.sub = this.ambientService.currentPalette$.subscribe((palette) => {
      this.handlePaletteChange(palette);
    });
  }

  ngAfterViewInit(): void {
    this.setStageProperties(this.stageA, this.pendingPalette);
    this.setStageProperties(this.stageB, this.pendingPalette);
    this.isInitialized = true;
    this.cdr.markForCheck();
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  private handlePaletteChange(palette: AmbientPalette): void {
    const key = `${palette.primary.r},${palette.primary.g},${palette.primary.b}_${palette.secondary.r},${palette.secondary.g},${palette.secondary.b}`;

    // Prevent redundant transitions
    if (this.currentPaletteKey === key && this.isInitialized) {
      return;
    }
    this.currentPaletteKey = key;
    this.pendingPalette = palette;

    if (!this.isInitialized) {
      return;
    }

    // Hardware-accelerated GPU opacity crossfade between stage A and stage B
    if (this.activeLayer === 'A') {
      this.setStageProperties(this.stageB, palette);
      this.activeLayer = 'B';
    } else {
      this.setStageProperties(this.stageA, palette);
      this.activeLayer = 'A';
    }

    this.cdr.markForCheck();
  }

  private setStageProperties(stage?: ElementRef<HTMLDivElement>, palette?: AmbientPalette): void {
    if (!stage?.nativeElement || !palette) return;
    const el = stage.nativeElement;
    el.style.setProperty('--color-p', `${palette.primary.r}, ${palette.primary.g}, ${palette.primary.b}`);
    el.style.setProperty('--color-s', `${palette.secondary.r}, ${palette.secondary.g}, ${palette.secondary.b}`);
    el.style.setProperty('--color-t', `${palette.tertiary.r}, ${palette.tertiary.g}, ${palette.tertiary.b}`);
  }
}
