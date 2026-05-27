# CRM Custom Field Dictionary Backfill

Fork-only runbook for `crm.they.dev`.

## Purpose

Use this backfill when custom field values exist in CRM records, but the related custom field dropdown does not show those values.

The command reads existing `custom_field_values` for active custom field definitions that have `configJson.dictionaryId`, then creates missing `dictionary_entries`.

It is safe to rerun. Existing dictionary entries are not changed.

## When To Run

Run it after importing or adding CRM data when:

- a custom field is dictionary-backed;
- records already contain values for that field;
- the edit form dropdown is missing those values.

This does not change CSV import behavior. Future imports still need this backfill unless automatic dictionary creation is added to the importer.

## Dry Run

Run dry-run first:

```bash
mercato entities backfill-dictionary-entries \
  --tenant 9b0f72ec-4ad3-4677-b3eb-834b515e3a06 \
  --org 199fb480-9402-4145-87c8-171a93f139d9
```

The report shows fields checked, unique values found, existing entries, and entries that would be created.

## Apply

Create the missing entries:

```bash
mercato entities backfill-dictionary-entries \
  --tenant 9b0f72ec-4ad3-4677-b3eb-834b515e3a06 \
  --org 199fb480-9402-4145-87c8-171a93f139d9 \
  --apply
```

Optional filters:

```bash
--entity customers:customer_person_profile
--field industry_external
```

## Verify

After apply:

1. Run the dry-run command again.
2. Confirm `Entries to create` is `0`.
3. Open or refresh the affected CRM form on `crm.they.dev`.
4. Confirm the dropdown contains the imported values.

No app restart is normally required. The dictionary entries API reads from the database on request. Users with an already-open form may need to refresh the page because the frontend can cache dropdown options during a session.

## Notes

- Scope is custom fields only, not core CRM fields.
- Only fields with `configJson.dictionaryId` are included.
- Values are trimmed before insert.
- Duplicate detection uses normalized dictionary values, so case-only duplicates are skipped.
- New entries use `label = value` and no icon or color.
