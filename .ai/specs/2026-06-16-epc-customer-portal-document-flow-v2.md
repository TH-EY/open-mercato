# EPC Customer Portal Document Flow v2

## TLDR

Customer portal order and quote details now support document PDFs, read-only attachments, quote comments, acceptance audit, order timeline, and a payment information panel. The flow is scoped to the authenticated customer user's company and keeps real payment collection out of scope.

## Overview

This extends the existing sales customer portal pages for `/{orgSlug}/portal/orders/[id]` and `/{orgSlug}/portal/quotes/[id]`. The implementation is intentionally additive: no database schema changes, no staff API contract changes, and no change to the public quote token acceptance route beyond sharing the same conversion service.

## Problem Statement

The first portal iteration exposed read-only lists/details and quote acceptance. EPC needs the next customer-facing workflow layer: downloadable documents, a clear acceptance record, customer questions on quotes, attachments supplied by staff, visible order progress, and a safe payment/deposit information surface.

## Proposed Solution

- Add scoped portal API routes for PDFs, attachments, order timeline, and quote comments.
- Require signer name and terms acceptance only for portal quote acceptance.
- Store portal acceptance audit data in existing quote/order `metadata` and create `SalesNote` audit entries for staff visibility.
- Use existing attachments storage via a portal-scoped download proxy instead of exposing staff-auth attachment routes.
- Show a payment panel from order totals and safe metadata fields; do not generate real payment provider links.

## Architecture

- Portal APIs use `getCustomerAuthFromRequest`, `requireCustomerFeature`, `customerEntityId`, `tenantId`, `organizationId`, and `deletedAt: null` document filters.
- PDF generation uses `pdf-lib` server-side, with no browser/Chromium runtime.
- Attachment listing and download require both the document scope check and exact `Attachment.entityId + recordId + tenantId + organizationId` match.
- Comments are `SalesNote` rows with `appearanceIcon: "message-circle"`.
- Acceptance audit notes use `appearanceIcon: "check-circle"` and are included in customer-safe order timeline.

## API Contracts

- `GET /api/sales/portal/orders/[id]/pdf`
- `GET /api/sales/portal/quotes/[id]/pdf`
- `GET /api/sales/portal/orders/[id]/attachments`
- `GET /api/sales/portal/quotes/[id]/attachments`
- `GET /api/sales/portal/orders/[id]/attachments/[attachmentId]`
- `GET /api/sales/portal/quotes/[id]/attachments/[attachmentId]`
- `GET /api/sales/portal/orders/[id]/timeline`
- `GET /api/sales/portal/quotes/[id]/comments`
- `POST /api/sales/portal/quotes/[id]/comments`
- `POST /api/sales/portal/quotes/[id]/accept` now requires portal body `{ acceptedByName, acceptedTerms: true }`.

## Data Models

No schema changes.

- `SalesQuote.metadata.portalAcceptance` and `SalesOrder.metadata.portalAcceptance` store signer, terms, timestamp, source, and customer user id/email.
- `SalesNote` records store customer comments and audit entries.
- Optional order payment panel fields are read from existing order totals plus metadata: `portalPaymentUrl`, `portalDepositAmount`, `portalPaymentInstructions`.

## Risks & Impact Review

- Cross-company leak: mitigated by document scope checks before every related read/download.
- Staff-only notes exposed to portal: mitigated by filtering portal-visible notes to known `appearanceIcon` values.
- Public quote accept regression: mitigated by keeping signer/terms optional in shared service and required only in portal route.
- Runtime PDF overhead: mitigated by pure JS `pdf-lib` and simple text-only PDFs.

## Final Compliance Report

- No DB migration required.
- New portal API routes export OpenAPI metadata.
- Existing staff sales APIs are unchanged.
- `portal.quotes.comment` is granted to Buyer; Portal Admin already has `portal.*`; Viewer remains read-only.

## Changelog

- 2026-06-16: Implemented portal document PDFs, attachments, quote comments, order timeline, payment panel, and portal acceptance audit.
