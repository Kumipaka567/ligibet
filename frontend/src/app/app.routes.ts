import { Routes } from '@angular/router';
import { adminGuard } from './core/guards/admin-guard';
import { authGuard } from './core/guards/auth-guard';

export const routes: Routes = [
  { path: '', redirectTo: 'login', pathMatch: 'full' },
  {
    path: 'login',
    loadComponent: () => import('./features/auth/auth-landing/auth-landing.component')
      .then((m) => m.AuthLandingComponent)
  },
  {
    path: 'verify-phone',
    loadComponent: () => import('./features/auth/phone-verification/phone-verification.component')
      .then((m) => m.PhoneVerificationComponent)
  },
  {
    path: 'dashboard',
    canActivate: [authGuard],
    loadComponent: () => import('./features/dashboard/player-dashboard.component')
      .then((m) => m.PlayerDashboardComponent)
  },
  {
    path: 'play',
    canActivate: [authGuard],
    loadComponent: () => import('./features/game/aviator/aviator.component')
      .then((m) => m.AviatorComponent)
  },
  {
    path: 'admin',
    canActivate: [adminGuard],
    loadComponent: () => import('./features/admin/admin-dashboard/admin-dashboard.component')
      .then((module) => module.AdminDashboardComponent)
  },
  {
    path: 'predator',
    canActivate: [adminGuard],
    loadComponent: () => import('./features/admin/predator/predator.component')
      .then((module) => module.PredatorComponent)
  },
  { path: 'wallet', redirectTo: 'dashboard' },
  { path: '**', redirectTo: 'login' }
];
