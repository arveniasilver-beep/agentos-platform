import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { SessionUser } from './auth.service';

/** Injects the authenticated user attached by AuthGuard. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): SessionUser | undefined => {
    const req = ctx.switchToHttp().getRequest<{ user?: SessionUser }>();
    return req.user;
  },
);
