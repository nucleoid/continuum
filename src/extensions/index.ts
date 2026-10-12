export * from './registry.js';
export * from './retrieval.js';
export * from './promotion.js';

import { PromotionWebhookRegistry } from './promotion.js';
import { RetrievalEnricherRegistry } from './retrieval.js';

export interface ExtensionRegistries {
  retrievalEnrichers: RetrievalEnricherRegistry;
  promotionWebhooks: PromotionWebhookRegistry;
}

export function defaultExtensionRegistries(): ExtensionRegistries {
  return {
    retrievalEnrichers: new RetrievalEnricherRegistry(),
    promotionWebhooks: new PromotionWebhookRegistry(),
  };
}
