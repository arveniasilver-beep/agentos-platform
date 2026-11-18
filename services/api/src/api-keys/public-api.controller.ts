import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ThrottlerGuard, Throttle } from '@nestjs/throttler';
import { loadServerEnv } from '@agentos/config';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { TasksService } from '../tasks/tasks.service';
import { createTaskSchema, type CreateTaskDto } from '../tasks/dto';
import { ApiKeyGuard } from './api-key.guard';
import { ApiKeyThrottlerGuard } from './api-key-throttler.guard';
import type { ApiKeyContext } from './api-keys.service';

interface ApiRequest {
  apiContext: ApiKeyContext;
}

const PUBLIC_API_THROTTLE = (() => {
  const env = loadServerEnv();
  return { default: { limit: env.PUBLIC_API_RATE_LIMIT, ttl: env.AUTH_RATE_WINDOW_SEC * 1000 } };
})();

/**
 * Public, programmatic API authenticated by an API key (Authorization: Bearer aos_...). Scoped to
 * the key's workspace; the key's creator is recorded as the task actor. Versioned under /v1.
 * ThrottlerGuard runs first (per-IP) so unauthenticated floods are capped before the DB lookup.
 */
@Controller('v1')
// ThrottlerGuard (per-IP) caps unauthenticated floods before the DB lookup; ApiKeyGuard
// authenticates; ApiKeyThrottlerGuard (per-key) caps a single key even across rotating IPs.
@UseGuards(ThrottlerGuard, ApiKeyGuard, ApiKeyThrottlerGuard)
@Throttle(PUBLIC_API_THROTTLE)
export class PublicApiController {
  constructor(private readonly tasks: TasksService) {}

  @Post('tasks')
  createTask(@Req() req: ApiRequest, @Body(new ZodValidationPipe(createTaskSchema)) dto: CreateTaskDto) {
    const { workspaceId, createdByUserId } = req.apiContext;
    return this.tasks.createAndStart(workspaceId, createdByUserId, dto);
  }

  @Get('tasks')
  listTasks(@Req() req: ApiRequest) {
    return this.tasks.list(req.apiContext.workspaceId);
  }

  @Get('tasks/:taskId')
  getTask(@Req() req: ApiRequest, @Param('taskId') taskId: string) {
    return this.tasks.get(req.apiContext.workspaceId, taskId);
  }
}
