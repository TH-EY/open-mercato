import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { features } from '../acl'
import { defaultEncryptionMaps } from '../encryption'
import { metadata } from '../index'
import { FINOO_IOD_ROLE, setup } from '../setup'
import rawIdentityWidget from '../widgets/injection/raw-identity/widget'

describe('FINOO identities module contract', () => {
  it('declares immutable access features and least-privilege default grants', () => {
    expect(metadata.name).toBe('finoo_identities')
    expect(features.map((feature) => feature.id)).toEqual([
      'finoo_identities.view',
      'finoo_identities.manage',
    ])
    expect(setup.defaultRoleFeatures).toEqual({
      superadmin: ['finoo_identities.*'],
      [FINOO_IOD_ROLE]: [
        'customers.people.view',
        'finoo_identities.view',
        'finoo_identities.manage',
      ],
    })
  })

  it('encrypts every raw identity and import-candidate field', () => {
    expect(defaultEncryptionMaps).toEqual([
      {
        entityId: 'finoo_identities:finoo_person_identity',
        fields: [
          { field: 'pesel' },
          { field: 'document_type' },
          { field: 'issuing_country_code' },
          { field: 'document_number' },
          { field: 'issued_on' },
          { field: 'expires_on' },
        ],
      },
      {
        entityId: 'finoo_identities:finoo_identity_import_conflict',
        fields: [
          { field: 'candidate_pesel' },
          { field: 'candidate_document_type' },
          { field: 'candidate_issuing_country_code' },
          { field: 'candidate_document_number' },
          { field: 'candidate_issued_on' },
          { field: 'candidate_expires_on' },
        ],
      },
    ])
  })

  it('gates the raw identity panel behind the immutable view feature', () => {
    expect(rawIdentityWidget.metadata).toMatchObject({
      id: 'finoo_identities.injection.raw-identity',
      features: ['finoo_identities.view'],
      requiredModules: ['customers'],
    })
  })

  it('stores encrypted identity dates in ciphertext-compatible text columns', () => {
    const migration = readFileSync(
      join(__dirname, '../migrations/Migration20260824161310_finoo_identities.ts'),
      'utf8',
    )
    expect(migration).toContain('"issued_on" text null')
    expect(migration).toContain('"expires_on" text null')
    expect(migration).toContain('"candidate_issued_on" text null')
    expect(migration).toContain('"candidate_expires_on" text null')
    expect(migration).not.toContain('"issued_on" date null')
    expect(migration).not.toContain('"candidate_issued_on" date null')
  })
})
