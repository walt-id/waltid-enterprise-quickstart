/** Fictional inputs for the SCA/PID quickstart. These are not registered identities or real payments. */
export const SCA_PID_SAMPLE = {
  card: { network: 'mastercard', card_id: 'example-token-reference' },
  user: { sub: 'urn:uuid:81df8af6-c1ac-4fd9-97d9-4f67512c47bb', masked_psu_id: 'EXAMPLE-****-001' },
  pid: { family_name: 'Example', given_name: 'Alice', birth_date: '1990-01-01', issuing_country: 'AT' },
  payment: { payee: { name: 'Example merchant', id: 'example-merchant' }, currency: 'EUR', amount: 12.34 },
  recurrence: { frequency: 'MNTH', number: 3 },
} as const;
