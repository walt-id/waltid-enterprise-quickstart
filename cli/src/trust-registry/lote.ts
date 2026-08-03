export const MDL_ISSUER_SERVICE_TYPE = 'urn:waltid:trust-service:mdl-issuer';

export interface LoteEntityInput {
  id: string;
  legalName: string;
  country: string;
  serviceName: string;
  serviceType: string;
  certificatePem?: string;
  otherIds?: string[];
}

function etsiDate(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function certificateDerBase64(pem: string): string {
  return pem.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s/g, '');
}

function multilingual(value: string): object {
  return { lang: 'en', value };
}

function multilingualUri(uriValue: string): object {
  return { lang: 'en', uriValue };
}

/** Build the normative ETSI TS 119 602 V1.1.1 Annex A.1 JSON binding. */
export function buildCertificateAnchorLote(
  listId: string,
  territory: string,
  entities: LoteEntityInput[]
): object {
  const issueDate = new Date();
  const nextUpdate = new Date(issueDate.getTime() + 365 * 24 * 60 * 60 * 1000);

  return {
    LoTE: {
      ListAndSchemeInformation: {
        LoTEVersionIdentifier: 1,
        LoTESequenceNumber: 1,
        LoTEType: 'http://uri.etsi.org/19602/LoTEType/EUPIDProvidersList',
        SchemeOperatorName: [multilingual('walt.id quickstart operator')],
        SchemeOperatorAddress: {
          SchemeOperatorPostalAddress: [{
            lang: 'en',
            StreetAddress: 'Quickstart test environment',
            Locality: 'Local',
            Country: territory,
          }],
          SchemeOperatorElectronicAddress: [multilingualUri('https://docs.walt.id/')],
        },
        SchemeName: [multilingual(`${listId} trust scheme`)],
        SchemeInformationURI: [multilingualUri('https://docs.walt.id/')],
        SchemeTerritory: territory,
        StatusDeterminationApproach: 'urn:waltid:trust-status:quickstart',
        ListIssueDateTime: etsiDate(issueDate),
        NextUpdate: etsiDate(nextUpdate),
      },
      TrustedEntitiesList: entities.map(entity => {
        const digitalIdentity: Record<string, unknown> = {};
        if (entity.certificatePem) {
          digitalIdentity.X509Certificates = [{ val: certificateDerBase64(entity.certificatePem) }];
        }
        if (entity.otherIds?.length) digitalIdentity.OtherIds = entity.otherIds;

        return {
          TrustedEntityInformation: {
            TEName: [multilingual(entity.legalName)],
            TEAddress: {
              TEPostalAddress: [{
                lang: 'en',
                StreetAddress: 'Quickstart test environment',
                Locality: 'Local',
                Country: entity.country,
              }],
              TEElectronicAddress: [multilingualUri('https://docs.walt.id/')],
            },
            TEInformationURI: [multilingualUri(
              `urn:waltid:trust-entity:${encodeURIComponent(entity.id)}`
            )],
          },
          TrustedEntityServices: [{
            ServiceInformation: {
              ServiceName: [multilingual(entity.serviceName)],
              ServiceDigitalIdentity: digitalIdentity,
              ServiceTypeIdentifier: entity.serviceType,
              ServiceStatus: 'http://uri.etsi.org/TrstSvc/TrustedList/Svcstatus/granted',
              StatusStartingTime: etsiDate(issueDate),
            },
          }],
        };
      }),
    },
  };
}
