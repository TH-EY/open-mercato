import {
  synchronizeFinooDealAttribution,
  type DealEventPayload,
  type SubscriberContext,
} from "../lib/attributionSync";

export const metadata = {
  event: "customers.deal.created",
  persistent: true,
  id: "finoo_affiliates:deal-created-attribution",
};

export default async function handleDealCreated(
  payload: DealEventPayload,
  context: SubscriberContext,
): Promise<void> {
  await synchronizeFinooDealAttribution(payload, context);
}
