import { Routes } from '@angular/router';
import { AviatorComponent } from './features/game/aviator/aviator.component';
import { WalletComponent } from './features/profile/wallet/wallet.component';
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
  { path: 'play', component: AviatorComponent, canActivate: [authGuard] },
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
  { path: 'wallet', component: WalletComponent, canActivate: [authGuard] },
  { path: '**', redirectTo: 'login' }
];
