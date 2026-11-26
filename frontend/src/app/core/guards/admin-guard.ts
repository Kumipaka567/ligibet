import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { catchError, map, switchMap, of } from 'rxjs';
import { AuthService } from '../services/auth.service';

function hasAdminAccess(role?: string): boolean {
  return role === 'admin' || role === 'superadmin';
}

export const adminGuard: CanActivateFn = (route, state) => {
  const authService = inject(AuthService);
  const router = inject(Router);

  if (!authService.hasToken()) {
    return router.createUrlTree(['/login']);
  }

  // Load fresh user from server to verify role, without kicking out a verified
  // admin on a transient timeout/503 (401/403 already clears the token).
  return authService.loadCurrentUser().pipe(
    map((res) => {
      if (hasAdminAccess(res?.user.role)) return true;
      if (!res && authService.hasToken() && hasAdminAccess(authService.currentUser$.getValue()?.role)) {
        return true;
      }
      if (!authService.hasToken()) return router.createUrlTree(['/login']);
      return router.createUrlTree(['/play']);
    }),
    catchError(() => of(router.createUrlTree(['/login'])))
  );
};
