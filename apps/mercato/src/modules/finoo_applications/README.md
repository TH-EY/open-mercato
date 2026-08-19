# FINOO application caller contract

The caller is the FINOO website backend. Browser-direct calls are prohibited.

## Request

`POST https://finoo.om.they.dev/api/finoo_applications/intake`

Required headers:

```text
Content-Type: application/json
Finoo-Message-Id: <new base64url nonce, 16..128 characters>
Finoo-Timestamp: <Unix epoch seconds>
Finoo-Signature: v1,<base64 HMAC-SHA256>
```

Create the signature over the ASCII bytes `<message-id>.<timestamp>.` followed by the exact JSON request bytes. Do not parse or reserialize between signing and sending. Timestamps are accepted for five minutes and the exact body limit is 65,536 bytes.

The receiver must run behind the configured trusted proxy chain and obtain a syntactically valid transport-peer IP from it. Missing, malformed, or misconfigured proxy identity fails closed with `503`; set `RATE_LIMIT_TRUST_PROXY_DEPTH` to the exact deployed proxy depth before enabling traffic.

`leadId` must be a stable server-generated string matching `^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$`. Draft and final submissions reuse the same `leadId` but use a new message ID. Never send a numeric `leadId`.

Every final submission must include the exact current consent registry version in `consentVersion`. The current value is `finoo-apply-2026-08-19-7e72cbeb`. A missing or stale version is rejected with `400`; update the caller only after the receiver's immutable registry has been deployed for the new version.

The canonical consent payload mirrors the current `finoo.pl/apply` UI: `contactConsent` plus `contactEmail` / `contactSms` / `contactPhone` for application contact, `emailConsent` / `smsConsent` / `telefonConsent` for optional FINOO.PL marketing, `emailConsent2` / `smsConsent2` / `telefonConsent2` for optional Hill Capital partner marketing, `jdgConsent.jdg1..jdg3` for JDG, and `legalConsent.legal1..legal2` for a company. The caller sends only `selected`; arbitrary text, timestamps, usernames and browser IP are rejected or stripped.

## Retry

- `202`: durably accepted. CRM processing is asynchronous.
- `200` with `duplicate: true`: the same message/body was already accepted.
- `409`: message ID was reused with different bytes; generate a new message ID only for a genuinely new delivery.
- Retry `429` and `5xx` with exponential backoff and the same message ID/body.
- Do not retry `400`, `401`, `409`, `413`, or `415` without correcting the request.

## Sensitive data

- Never call the endpoint from browser JavaScript or expose the signing secret.
- Do not forward `kontomatikToken`; the receiver discards it defensively.
- Do not send browser-provided IP or acceptance time. The receiver records its own acceptance time and a pseudonymous digest of the server-to-server transport peer.
- Resolve consent text/code from the server-side version registry, not browser-provided arbitrary strings.
- Never log the body, signature, NIP, PESEL, identity document, contact values, consent text, or client IP.

## Synthetic fixture

```json
{
  "leadId": "synthetic_104_0001",
  "consentVersion": "finoo-apply-2026-08-19-7e72cbeb",
  "przeszedl_caly_wniosek": "Tak",
  "leadType": "business",
  "name": "Test",
  "surname": "Applicant",
  "email": "synthetic-104@example.invalid",
  "companyName": "Synthetic THOM 104",
  "nip": "0000000000",
  "businessType": "company",
  "amount": "100000",
  "months": "12",
  "acceptTerms": true,
  "contactConsent": true,
  "contactEmail": true,
  "contactSms": true,
  "contactPhone": true,
  "legalConsent": {
    "legal1": { "selected": true },
    "legal2": { "selected": true }
  },
  "kontomatikCompleted": false
}
```

This fixture is schema documentation only. Runtime QA must generate unique synthetic identifiers and clean every created CRM/intake/projection row.
