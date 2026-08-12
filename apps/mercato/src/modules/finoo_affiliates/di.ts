import { asFunction, asValue } from "awilix";
import type { EntityManager } from "@mikro-orm/postgresql";
import type { AppContainer } from "@open-mercato/shared/lib/di/container";
import {
  FinooAffiliateLink,
  FinooAffiliateVisit,
  FinooDealAttribution,
} from "./data/entities";
import { createFinooAffiliateService } from "./lib/service";

export function register(container: AppContainer) {
  container.register({
    FinooAffiliateLink: asValue(FinooAffiliateLink),
    FinooAffiliateVisit: asValue(FinooAffiliateVisit),
    FinooDealAttribution: asValue(FinooDealAttribution),
    finooAffiliateService: asFunction(({ em }: { em: EntityManager }) =>
      createFinooAffiliateService(em),
    )
      .scoped()
      .proxy(),
  });
}
