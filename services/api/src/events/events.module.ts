import { Global, Module } from '@nestjs/common';
import { TaskEventBus } from './task-event-bus';

/** Global so the run path can publish and the gateway can subscribe without import wiring. */
@Global()
@Module({
  providers: [TaskEventBus],
  exports: [TaskEventBus],
})
export class EventsModule {}
