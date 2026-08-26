import { enrichers } from '../enrichers'

describe('FINOO identity completeness enricher', () => {
  it('adds per-field statuses without selecting encrypted identity values', async () => {
    const em = {
      findOne: jest.fn(async (_entity: unknown, _where: unknown, options: { fields?: string[] }) => {
        expect(options.fields).toEqual(['personId', 'isComplete', 'fieldStatuses'])
        return {
          personId: 'ee823a18-e50c-4de4-9d71-4f516d7d754e',
          isComplete: false,
          fieldStatuses: {
            pesel: 'complete',
            documentType: 'complete',
            issuingCountryCode: 'missing',
            documentNumber: 'missing',
            issuedOn: 'complete',
            expiresOn: 'complete',
            rawPesel: '44051401458',
          },
        }
      }),
    }
    const enricher = enrichers[0]

    const result = await enricher.enrichOne!(
      { id: 'ee823a18-e50c-4de4-9d71-4f516d7d754e', display_name: 'Jan Kowalski' },
      {
        em,
        tenantId: '5164d495-1865-4738-b459-2783999a761d',
        organizationId: 'd0d98cb3-28cf-4376-a61c-d270020f166f',
      } as never,
    )

    expect(result).toMatchObject({
      _finooIdentities: {
        isComplete: false,
        statuses: {
          pesel: 'complete',
          issuingCountryCode: 'missing',
          documentNumber: 'missing',
        },
      },
    })
    expect(JSON.stringify(result)).not.toContain('44051401458')
  })
})
