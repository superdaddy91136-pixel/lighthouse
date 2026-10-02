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

  constructor(
    public memory: MemoryService,
    private router: Router,
  ) {}

  ngOnInit(): void {
    this.sub = this.memory.activeNavTab.subscribe((tab) => {
      this.activeTab = tab;
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  selectTab(tab: NavTab): void {
    if (tab === NavTab.Profile) {
      this.memory.activeNavTab.next(NavTab.Profile);
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
