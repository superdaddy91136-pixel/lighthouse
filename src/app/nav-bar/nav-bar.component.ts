import { Component, OnDestroy, OnInit } from "@angular/core";
import { Router } from "@angular/router";
import { Subscription } from "rxjs";
import { MemoryService } from "../memory.service";
import { NavTab } from "../models/navTab";

@Component({
  selector: "app-nav-bar",
  templateUrl: "./nav-bar.component.html",
  styleUrl: "./nav-bar.component.css",
})
export class NavBarComponent implements OnInit, OnDestroy {
  navTabEnum = NavTab;
  activeTab: NavTab = NavTab.Home;
  private sub?: Subscription;

  private lastHomeClickTime: number = 0;
  private tabOnFirstClick: NavTab | null = null;
  private lastHomeRefreshTime: number = 0;

  constructor(
    public memory: MemoryService,
    private router: Router,
  ) {}

  ngOnInit(): void {
    this.sub = this.memory.activeNavTab.subscribe((tab) => {
      this.activeTab = tab;
      if (tab !== NavTab.Home) {
        this.tabOnFirstClick = null;
        this.lastHomeClickTime = 0;
      }
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  onHomeClick(event?: MouseEvent): void {
    const isAlreadyOnHome =
      this.activeTab === NavTab.Home &&
      (this.router.url === "/" || this.router.url === "");
    const now = Date.now();
    const timeSinceLastClick = now - this.lastHomeClickTime;

    // Check if this click completes a double-click on Home
    if (
      isAlreadyOnHome &&
      this.tabOnFirstClick === NavTab.Home &&
      timeSinceLastClick > 0 &&
      timeSinceLastClick <= 500
    ) {
      this.lastHomeClickTime = 0;
      this.tabOnFirstClick = null;
      this.triggerHomeRefresh();
      return;
    }

    // First click or click outside double-click window
    if (isAlreadyOnHome) {
      this.tabOnFirstClick = NavTab.Home;
      this.lastHomeClickTime = now;
    } else {
      this.tabOnFirstClick = null;
      this.lastHomeClickTime = 0;
    }

    this.selectTab(NavTab.Home);
  }

  onHomeDoubleClick(event?: MouseEvent): void {
    if (event) {
      event.preventDefault();
    }

    // Only refresh if double-click started while already on Home
    if (this.tabOnFirstClick !== NavTab.Home) {
      return;
    }

    const isAlreadyOnHome =
      this.activeTab === NavTab.Home &&
      (this.router.url === "/" || this.router.url === "");

    if (isAlreadyOnHome) {
      this.tabOnFirstClick = null;
      this.lastHomeClickTime = 0;
      this.triggerHomeRefresh();
    }
  }

  private triggerHomeRefresh(): void {
    const now = Date.now();
    // Throttle to prevent overlapping / duplicate refreshes within 1 second
    if (now - this.lastHomeRefreshTime < 1000) {
      return;
    }
    this.lastHomeRefreshTime = now;
    this.memory.Refresh.next(true);
  }

  selectTab(tab: NavTab): void {
    if (tab !== NavTab.Home) {
      this.tabOnFirstClick = null;
      this.lastHomeClickTime = 0;
    }

    if (tab === NavTab.Profile) {
      this.memory.activeNavTab.next(NavTab.Profile);
      this.router.navigateByUrl("profile");
      return;
    }
    if (tab === NavTab.Settings) {
      this.memory.activeNavTab.next(NavTab.Settings);
      this.router.navigateByUrl("settings");
      return;
    }

    this.memory.activeNavTab.next(tab);
    if (this.router.url !== "/" && this.router.url !== "") {
      this.router.navigateByUrl("").then(() => {
        this.memory.navTabClick.next(tab);
      });
    } else {
      this.memory.navTabClick.next(tab);
    }
  }
}
