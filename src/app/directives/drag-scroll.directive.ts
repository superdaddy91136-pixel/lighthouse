import { Directive, ElementRef, NgZone, OnDestroy, OnInit } from '@angular/core';

@Directive({
  selector: '[appDragScroll], .row-track, .cast-track, .season-selector-track'
})
export class DragScrollDirective implements OnInit, OnDestroy {
  private el: HTMLElement;
  private isDown = false;
  private activePointerId: number | null = null;
  private startX = 0;
  private startY = 0;
  private startScrollLeft = 0;
  private draggedPastThreshold = false;
  private hasPointerCapture = false;
  private clearThresholdTimer: any = null;
  private readonly DRAG_THRESHOLD = 6;

  constructor(
    private elementRef: ElementRef<HTMLElement>,
    private ngZone: NgZone
  ) {
    this.el = this.elementRef.nativeElement;
  }

  ngOnInit(): void {
    // Run outside Angular zone for high-performance 60fps+ tracking
    this.ngZone.runOutsideAngular(() => {
      // Allow vertical page scroll gestures on touch while handling horizontal drag
      this.el.style.touchAction = 'pan-y';

      this.el.addEventListener('pointerdown', this.onPointerDown);
      this.el.addEventListener('pointercancel', this.onPointerCancel);
      this.el.addEventListener('lostpointercapture', this.onLostPointerCapture);
      this.el.addEventListener('dragstart', this.onDragStart);

      // Capture phase click listener ensures we intercept clicks BEFORE child card click handlers
      this.el.addEventListener('click', this.onClickCapture, true);

      // Permanent window blur and visibility listeners to guarantee cleanup on focus loss
      window.addEventListener('blur', this.onWindowBlur);
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    });
  }

  ngOnDestroy(): void {
    this.cleanupDrag(true);

    this.el.removeEventListener('pointerdown', this.onPointerDown);
    this.el.removeEventListener('pointercancel', this.onPointerCancel);
    this.el.removeEventListener('lostpointercapture', this.onLostPointerCapture);
    this.el.removeEventListener('dragstart', this.onDragStart);
    this.el.removeEventListener('click', this.onClickCapture, true);

    window.removeEventListener('blur', this.onWindowBlur);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);

    if (this.clearThresholdTimer) {
      clearTimeout(this.clearThresholdTimer);
      this.clearThresholdTimer = null;
    }
  }

  private onDragStart = (event: DragEvent) => {
    // Prevent default browser image/link drag which interrupts pointermove
    event.preventDefault();
  };

  private onPointerDown = (event: PointerEvent) => {
    // Ignore if already tracking an active pointer
    if (this.isDown || this.activePointerId !== null) return;

    // Only drag with primary (left) mouse button
    if (event.button !== 0) return;

    // If click was on an interactive button or control, do not initiate drag unless it's a draggable track item
    const target = event.target as HTMLElement | null;
    if (target) {
      const isTrackItemButton = !!target.closest('.season-pill-btn, .season-selector-track button');
      if (!isTrackItemButton && target.closest('button, a, input, select, textarea, [mat-menu-item], .btn-card-menu, .card-fav-btn, .card-cw-menu-btn, [role="button"]')) {
        return;
      }
    }

    // If click was on a native scrollbar track/thumb, do not intercept
    if (event.offsetX > this.el.clientWidth || event.offsetY > this.el.clientHeight) {
      return;
    }

    this.isDown = true;
    this.activePointerId = event.pointerId;
    this.startX = event.clientX;
    this.startY = event.clientY;
    this.startScrollLeft = this.el.scrollLeft;
    this.draggedPastThreshold = false;
    this.hasPointerCapture = false;

    if (this.clearThresholdTimer) {
      clearTimeout(this.clearThresholdTimer);
      this.clearThresholdTimer = null;
    }

    // Attach tracking listeners to window so dragging smoothly tracks anywhere
    window.addEventListener('pointermove', this.onPointerMove, { passive: false });
    window.addEventListener('pointerup', this.onPointerUp, true);
    window.addEventListener('pointercancel', this.onPointerCancel, true);
    window.addEventListener('mouseup', this.onMouseUpFallback, true);
  };

  private onPointerMove = (event: PointerEvent) => {
    if (!this.isDown) return;

    // Ignore unrelated pointers
    if (this.activePointerId !== null && event.pointerId !== this.activePointerId) return;

    // Safety failsafe: if mouse button was released outside window without event, stop immediately
    if (event.pointerType === 'mouse' && (event.buttons & 1) === 0) {
      this.cleanupDrag(true);
      return;
    }

    const dx = event.clientX - this.startX;
    const dy = event.clientY - this.startY;

    if (!this.draggedPastThreshold) {
      // If user moved past threshold horizontally, start drag mode
      if (Math.abs(dx) >= this.DRAG_THRESHOLD) {
        this.draggedPastThreshold = true;
        this.el.classList.add('is-dragging');
        // Disable smooth scroll during active mouse dragging for direct 1:1 response
        this.el.style.scrollBehavior = 'auto';

        // Capture pointer so carousel keeps receiving events even if cursor leaves window/carousel
        try {
          this.el.setPointerCapture(event.pointerId);
          this.hasPointerCapture = true;
        } catch {
          this.hasPointerCapture = false;
        }
      } else if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > this.DRAG_THRESHOLD) {
        // User is scrolling vertically - cancel horizontal tracking to allow smooth page scroll
        this.cleanupDrag(true);
        return;
      }
    }

    if (this.draggedPastThreshold) {
      this.el.scrollLeft = this.startScrollLeft - dx;
      // Prevent accidental vertical scrolling or text selection while intentionally dragging
      event.preventDefault();
    }
  };

  private onPointerUp = (event: PointerEvent) => {
    if (this.activePointerId !== null && event.pointerId !== this.activePointerId) return;

    const wasDragged = this.draggedPastThreshold;
    this.cleanupDrag();

    if (wasDragged) {
      // Maintain threshold flag briefly so the immediately-fired 'click' event is intercepted
      this.draggedPastThreshold = true;
      this.clearThresholdTimer = setTimeout(() => {
        this.draggedPastThreshold = false;
        this.clearThresholdTimer = null;
      }, 120);
    }
  };

  private onMouseUpFallback = (event: MouseEvent) => {
    if (this.isDown) {
      const wasDragged = this.draggedPastThreshold;
      this.cleanupDrag();

      if (wasDragged) {
        this.draggedPastThreshold = true;
        if (this.clearThresholdTimer) {
          clearTimeout(this.clearThresholdTimer);
        }
        this.clearThresholdTimer = setTimeout(() => {
          this.draggedPastThreshold = false;
          this.clearThresholdTimer = null;
        }, 120);
      }
    }
  };

  private onPointerCancel = (event: PointerEvent) => {
    if (this.isDown) {
      this.cleanupDrag(true);
    }
  };

  private onLostPointerCapture = (event: PointerEvent) => {
    this.hasPointerCapture = false;
    if (this.isDown) {
      this.cleanupDrag(true);
    }
  };

  private onWindowBlur = () => {
    if (this.isDown) {
      this.cleanupDrag(true);
    }
  };

  private onVisibilityChange = () => {
    if (document.hidden && this.isDown) {
      this.cleanupDrag(true);
    }
  };

  private cleanupDrag(resetThreshold = false): void {
    if (this.hasPointerCapture && this.activePointerId !== null) {
      try {
        if (this.el.hasPointerCapture(this.activePointerId)) {
          this.el.releasePointerCapture(this.activePointerId);
        }
      } catch {
        // ignore
      }
    }
    this.hasPointerCapture = false;
    this.isDown = false;
    this.activePointerId = null;

    // Remove window tracking listeners
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp, true);
    window.removeEventListener('pointercancel', this.onPointerCancel, true);
    window.removeEventListener('mouseup', this.onMouseUpFallback, true);

    // Remove dragging classes and restore smooth scrolling
    this.el.classList.remove('is-dragging');
    this.el.style.scrollBehavior = '';

    if (resetThreshold) {
      this.draggedPastThreshold = false;
      if (this.clearThresholdTimer) {
        clearTimeout(this.clearThresholdTimer);
        this.clearThresholdTimer = null;
      }
    }
  }

  private onClickCapture = (event: MouseEvent) => {
    if (this.draggedPastThreshold) {
      // Suppress click event so card click / navigation handler is NOT triggered
      event.stopPropagation();
      event.stopImmediatePropagation();
      event.preventDefault();
      this.draggedPastThreshold = false;
      if (this.clearThresholdTimer) {
        clearTimeout(this.clearThresholdTimer);
        this.clearThresholdTimer = null;
      }
    }
  };
}
