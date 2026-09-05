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

  // Always load fresh user from server to ensure role is accurate.
  // Avoids race conditions where currentUser$ is stale or null after a page refresh.
  return authService.loadCurrentUser().pipe(
    map((res) => {
      if (hasAdminAccess(res?.user.role)) return true;
      return router.createUrlTree(['/play']);
    }),
    catchError(() => of(router.createUrlTree(['/login'])))
  );
};
