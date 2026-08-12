import {
  synchronizeFinooDealAttribution,
  type DealEventPayload,
  type SubscriberContext,
} from "../lib/attributionSync";

export const metadata = {
  event: "customers.deal.updated",
  persistent: true,
  id: "finoo_affiliates:deal-updated-attribution",
};

export default async function handleDealUpdated(
  payload: DealEventPayload,
  context: SubscriberContext,
): Promise<void> {
  await synchronizeFinooDealAttribution(payload, context);
}
