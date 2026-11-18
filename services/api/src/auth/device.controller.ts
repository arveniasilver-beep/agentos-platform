import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from './auth.guard';
import { CurrentUser } from './current-user.decorator';
import type { SessionUser } from './auth.service';
import { AuthService } from './auth.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

const registerDeviceSchema = z.object({
  name: z.string().min(1).max(120),
  platform: z.enum(['desktop', 'android', 'web', 'other']).default('desktop'),
  userAgent: z.string().max(500).optional(),
});
type RegisterDeviceDto = z.infer<typeof registerDeviceSchema>;

/**
 * Device Sync (TICKET-5): a user manages the long-lived Bearer credentials their desktop/Android
 * devices use to reach the same workspace APIs. Guarded by the normal session — you register/revoke a
 * device from an authenticated session. The token is returned ONCE on registration.
 */
@Controller('auth/devices')
@UseGuards(AuthGuard)
export class DeviceController {
  constructor(private readonly auth: AuthService) {}

  @Post()
  register(@CurrentUser() user: SessionUser, @Body(new ZodValidationPipe(registerDeviceSchema)) dto: RegisterDeviceDto) {
    return this.auth.registerDevice(user.id, dto.name, dto.platform, dto.userAgent);
  }

  @Get()
  list(@CurrentUser() user: SessionUser) {
    return this.auth.listDevices(user.id);
  }

  @Delete(':id')
  revoke(@CurrentUser() user: SessionUser, @Param('id') id: string) {
    return this.auth.revokeDevice(user.id, id);
  }
}
