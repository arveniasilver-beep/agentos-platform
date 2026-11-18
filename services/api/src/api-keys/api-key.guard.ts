import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiKeysService, type ApiKeyContext } from './api-keys.service';

interface RequestWithApiKey {
  headers: Record<string, string | string[] | undefined>;
  apiContext?: ApiKeyContext;
}

/** Authenticates public-API requests via `Authorization: Bearer aos_...` and attaches the context. */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly apiKeys: ApiKeysService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<RequestWithApiKey>();
    const header = req.headers['authorization'];
    const value = Array.isArray(header) ? header[0] : header;
    const token = value?.startsWith('Bearer ') ? value.slice(7).trim() : '';
    const resolved = token ? await this.apiKeys.resolve(token) : null;
    if (!resolved) {
      throw new UnauthorizedException('Invalid or missing API key');
    }
    req.apiContext = resolved;
    return true;
  }
}
