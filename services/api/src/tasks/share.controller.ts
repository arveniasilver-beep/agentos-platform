import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ThrottlerGuard, Throttle } from '@nestjs/throttler';
import { loadServerEnv } from '@agentos/config';
import { TasksService } from './tasks.service';

const SHARE_THROTTLE = (() => {
  const env = loadServerEnv();
  return { default: { limit: env.PUBLIC_API_RATE_LIMIT, ttl: env.AUTH_RATE_WINDOW_SEC * 1000 } };
})();

/**
 * Public, UNAUTHENTICATED read-only replay of a shared task. The opaque shareId IS the capability;
 * per-IP throttled so the public surface can't be enumerated/flooded.
 */
@Controller('public/replay')
@UseGuards(ThrottlerGuard)
@Throttle(SHARE_THROTTLE)
export class ShareController {
  constructor(private readonly tasks: TasksService) {}

  @Get(':shareId')
  replay(@Param('shareId') shareId: string) {
    return this.tasks.getSharedReplay(shareId);
  }
}
