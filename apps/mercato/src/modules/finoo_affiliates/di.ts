import { asFunction, asValue } from "awilix";
import type { EntityManager } from "@mikro-orm/postgresql";
import type { AppContainer } from "@open-mercato/shared/lib/di/container";
import {
  FinooAffiliate,
  FinooAffiliateLink,
  FinooAffiliatePayout,
  FinooAffiliateTransaction,
  FinooAffiliateVisit,
  FinooDealAcceptance,
  FinooDealAttribution,
  FinooPayoutPreview,
} from "./data/entities";
import { createFinooAffiliateService } from "./lib/service";

export function register(container: AppContainer) {
  container.register({
    FinooAffiliate: asValue(FinooAffiliate),
    FinooAffiliateLink: asValue(FinooAffiliateLink),
    FinooAffiliatePayout: asValue(FinooAffiliatePayout),
    FinooAffiliateTransaction: asValue(FinooAffiliateTransaction),
    FinooAffiliateVisit: asValue(FinooAffiliateVisit),
    FinooDealAcceptance: asValue(FinooDealAcceptance),
    FinooDealAttribution: asValue(FinooDealAttribution),
    FinooPayoutPreview: asValue(FinooPayoutPreview),
    finooAffiliateService: asFunction(({ em }: { em: EntityManager }) =>
      createFinooAffiliateService(em),
    )
      .scoped()
      .proxy(),
  });
}
