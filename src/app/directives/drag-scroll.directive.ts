import { Directive, ElementRef, HostListener, NgZone, OnDestroy, OnInit } from '@angular/core';

@Directive({
  selector: '[appDragScroll], .row-track, .cast-track, .season-selector-track'
})
export class DragScrollDirective implements OnInit, OnDestroy {
  private el: HTMLElement;
  private isDown = false;
  private startX = 0;
  private startScrollLeft = 0;
  private draggedPastThreshold = false;
  private clearThresholdTimer: any = null;
  private readonly DRAG_THRESHOLD = 6;

  constructor(
    private elementRef: ElementRef<HTMLElement>,
    private ngZone: NgZone
  ) {
    this.el = this.elementRef.nativeElement;
  }

  ngOnInit(): void {
    // Run outside Angular zone for high-performance 60fps+ mouse tracking
    this.ngZone.runOutsideAngular(() => {
      this.el.addEventListener('mousedown', this.onMouseDown);
      this.el.addEventListener('dragstart', this.onDragStart);
      // Capture phase click listener ensures we intercept clicks BEFORE any child card click handlers
      this.el.addEventListener('click', this.onClickCapture, true);
    });
  }

  ngOnDestroy(): void {
    this.cleanupDrag();
    this.el.removeEventListener('mousedown', this.onMouseDown);
    this.el.removeEventListener('dragstart', this.onDragStart);
    this.el.removeEventListener('click', this.onClickCapture, true);
    if (this.clearThresholdTimer) {
      clearTimeout(this.clearThresholdTimer);
    }
  }

  private onDragStart = (event: DragEvent) => {
    // Prevent default browser image/link drag which interrupts mousemove
    event.preventDefault();
  };

  private onMouseDown = (event: MouseEvent) => {
    // Only drag with primary (left) mouse button
    if (event.button !== 0) return;

    // If click was on an interactive button or control, do not initiate drag
    const target = event.target as HTMLElement;
    if (target && target.closest('button, a, input, select, textarea, [mat-menu-item], .btn-card-menu, .card-fav-btn')) {
      return;
    }

    // If click was on a native scrollbar track/thumb, do not intercept
    if (event.offsetX > this.el.clientWidth || event.offsetY > this.el.clientHeight) {
      return;
    }

    this.isDown = true;
    this.startX = event.pageX;
    this.startScrollLeft = this.el.scrollLeft;
    this.draggedPastThreshold = false;

    if (this.clearThresholdTimer) {
      clearTimeout(this.clearThresholdTimer);
      this.clearThresholdTimer = null;
    }

    // Attach to document to smoothly track dragging even if mouse exits container
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('mouseup', this.onMouseUp);
  };

  private onMouseMove = (event: MouseEvent) => {
    if (!this.isDown) return;

    const dx = event.pageX - this.startX;

    if (!this.draggedPastThreshold) {
      if (Math.abs(dx) >= this.DRAG_THRESHOLD) {
        this.draggedPastThreshold = true;
        this.el.classList.add('is-dragging');
        // Disable smooth scroll during active mouse dragging for direct 1:1 response
        this.el.style.scrollBehavior = 'auto';
      }
    }

    if (this.draggedPastThreshold) {
      this.el.scrollLeft = this.startScrollLeft - dx;
      event.preventDefault();
    }
  };

  private onMouseUp = (event: MouseEvent) => {
    if (!this.isDown) return;
    this.cleanupDrag();

    if (this.draggedPastThreshold) {
      // Maintain threshold flag briefly so the immediately-fired 'click' event is intercepted
      this.clearThresholdTimer = setTimeout(() => {
        this.draggedPastThreshold = false;
        this.clearThresholdTimer = null;
      }, 100);
    }
  };

  private cleanupDrag(): void {
    this.isDown = false;
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('mouseup', this.onMouseUp);

    this.el.classList.remove('is-dragging');
    this.el.style.scrollBehavior = '';
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

  @HostListener('window:blur')
  onWindowBlur(): void {
    if (this.isDown) {
      this.cleanupDrag();
      this.draggedPastThreshold = false;
    }
  }
}
