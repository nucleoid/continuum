import type { ScopeRef } from '../types.js';
import { ExtensionRegistry } from './registry.js';

export interface PromotionEvent {
  readonly eventId: string;
  readonly sourceId: string;
  readonly destinationId: string;
  readonly destinationScopeId: string;
  readonly destinationScope: ScopeRef;
  readonly principalId: string;
  readonly occurredAt: Date;
}

export interface PromotionWebhookContext {
  readonly signal: AbortSignal;
}

export interface PromotionWebhook {
  readonly id: string;
  onPromoted(event: PromotionEvent, context: PromotionWebhookContext): Promise<void>;
}

export class PromotionWebhookRegistry extends ExtensionRegistry<PromotionWebhook> {}
