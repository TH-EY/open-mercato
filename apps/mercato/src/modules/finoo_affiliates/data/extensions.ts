import { defineLink, entityId } from "@open-mercato/shared/modules/dsl";
import type { EntityExtension } from "@open-mercato/shared/modules/entities";

export const extensions: EntityExtension[] = [
  defineLink(
    entityId("customers", "customer_deal"),
    entityId("finoo_affiliates", "finoo_deal_attribution"),
    {
      join: { baseKey: "id", extensionKey: "deal_id" },
      cardinality: "one-to-one",
      required: false,
      description:
        "Finoo affiliate attribution and commission fields for a CRM Deal.",
    },
  ),
];

export default extensions;
