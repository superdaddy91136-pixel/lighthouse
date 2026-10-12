import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { SetupComponent } from './setup/setup.component';
import { HomeComponent } from './home/home.component';
import { SettingsComponent } from './settings/settings.component';
import { ProfileComponent } from './profile/profile.component';
import { MovieDetailComponent } from './movie-detail/movie-detail.component';
import { TvDetailComponent } from './tv-detail/tv-detail.component';

const routes: Routes = [
  {path: "", component: HomeComponent},
  {path: "setup", component: SetupComponent},
  {path: "profile", component: ProfileComponent},
  {path: "settings", component: SettingsComponent},
  {path: "movie-detail", component: MovieDetailComponent},
  {path: "tv-detail", component: TvDetailComponent},
];

@NgModule({
  imports: [RouterModule.forRoot(routes, { scrollPositionRestoration: 'disabled' })],
  exports: [RouterModule]
})
export class AppRoutingModule { }
