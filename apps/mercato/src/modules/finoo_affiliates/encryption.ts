import type { ModuleEncryptionMap } from "@open-mercato/shared/modules/encryption";

export const defaultEncryptionMaps: ModuleEncryptionMap[] = [
  {
    entityId: "finoo_affiliates:finoo_deal_attribution",
    fields: [
      { field: "company_name" },
      { field: "landing_page" },
      { field: "initial_referrer" },
    ],
  },
];

export default defaultEncryptionMaps;
