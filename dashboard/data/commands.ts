import type { CommandCategory } from '~/types'

export const COMMAND_CATEGORIES: CommandCategory[] = [
  {
    id: 'system',
    label: 'System',
    color: 'red',
    icon: 'server',
    description: 'Database initialization and organization bootstrap',
    commands: [
      {
        flag: '--recreate',
        label: 'Full Recreate',
        description: 'Fresh start: drop DB + full setup + run primary use case',
        danger: true,
      },
      {
        flag: '--init-system',
        label: 'Init System',
        description: 'Initialize database only',
      },
      {
        flag: '--setup-create-superadmin',
        label: 'Create Superadmin',
        description: 'Create the superadmin account',
      },
      {
        flag: '--setup-create-organization',
        label: 'Create Organization',
        description: 'Create the organization',
      },
      {
        flag: '--setup-create-admin-role',
        label: 'Create Admin Role',
        description: 'Create admin role (auto-created with org)',
      },
      {
        flag: '--setup-create-admin-account',
        label: 'Create Admin Account',
        description: 'Create admin user and assign role',
      },
    ],
  },
  {
    id: 'setup',
    label: 'Setup',
    color: 'blue',
    icon: 'cog',
    description: 'Resource creation and service configuration',
    commands: [
      {
        flag: '--setup-all',
        label: 'Setup All',
        description: 'Run all setup commands in dependency order',
      },
      {
        flag: '--setup-login',
        label: 'Login (Admin)',
        description: 'Authenticate as admin user',
      },
      {
        flag: '--setup-login-superadmin',
        label: 'Login (Superadmin)',
        description: 'Authenticate as superadmin',
      },
      {
        flag: '--setup-create-tenant',
        label: 'Create Tenant',
        description: 'Create organization tenant',
      },
      {
        flag: '--setup-create-wallet',
        label: 'Create Wallet',
        description: 'Initialize wallet service',
      },
      {
        flag: '--setup-create-verifier2',
        label: 'Create Verifier2',
        description: 'Create verifier2 service',
      },
      {
        flag: '--setup-create-services',
        label: 'Create Services',
        description: 'Create KMS, X.509 Service, and X.509 Store',
      },
      {
        flag: '--setup-link-x509-dependencies',
        label: 'Link X.509 Deps',
        description: 'Link KMS to x509-service and x509-store',
      },
      {
        flag: '--setup-import-keys',
        label: 'Import Keys',
        description: 'Import IACA, issuer, attester, and VICAL keys',
      },
      {
        flag: '--setup-create-iaca-certificate',
        label: 'Create IACA Cert',
        description: 'Create IACA root certificate',
      },
      {
        flag: '--setup-create-document-signer-certificate',
        label: 'Create DS Cert',
        description: 'Create document signer certificate',
      },
      {
        flag: '--setup-store-vical-signer-certificate',
        label: 'Store VICAL Signer Cert',
        description: 'Store VICAL signer X.509 certificate',
      },
      {
        flag: '--setup-create-vical-service',
        label: 'Create VICAL Service',
        description: 'Create VICAL service',
      },
      {
        flag: '--setup-publish-vical',
        label: 'Publish VICAL',
        description: 'Publish VICAL with IACA certificate',
      },
      {
        flag: '--setup-create-client-attester',
        label: 'Create Client Attester',
        description: 'Create client attestation service',
      },
      {
        flag: '--setup-create-issuer2',
        label: 'Create Issuer2',
        description: 'Create issuer2 with client attestation',
      },
      {
        flag: '--setup-create-issuer-profile',
        label: 'Create Issuer Profile',
        description: 'Create mDL credential issuer profile',
      },
      {
        flag: '--setup-link-wallet-to-attester',
        label: 'Link Wallet → Attester',
        description: 'Link wallet service to client attester',
      },
      {
        flag: '--setup-obtain-wallet-attestation',
        label: 'Obtain Wallet Attestation',
        description: 'Wallet obtains client attestation JWT',
      },
      {
        flag: '--setup-create-trust-registry',
        label: 'Create Trust Registry',
        description: 'Create trust registry service',
      },
    ],
  },
  {
    id: 'run',
    label: 'Run',
    color: 'green',
    icon: 'play',
    description: 'Execute mDL issuance and verification use case flows',
    commands: [
      {
        flag: '--run-all',
        label: 'Run All',
        description: 'Full mDL issue + verify end-to-end flow',
      },
      {
        flag: '--run-create-credential-offer',
        label: 'Create Credential Offer',
        description: 'Create mDL credential offer (pre-authorized code)',
      },
      {
        flag: '--run-wallet-receive-credential',
        label: 'Wallet Receive Credential',
        description: 'Wallet receives via pre-authorized flow',
      },
      {
        flag: '--run-create-verification-session',
        label: 'Create Verification Session',
        description: 'Create verifier2 verification session',
      },
      {
        flag: '--run-wallet-present',
        label: 'Wallet Present',
        description: 'Wallet presents credential to verifier',
      },
      {
        flag: '--run-assert-final-status',
        label: 'Assert Final Status',
        description: 'Assert verification session is SUCCESSFUL',
      },
    ],
  },
  {
    id: 'flow',
    label: 'Flows',
    color: 'purple',
    icon: 'arrows',
    description: 'Specialized verification flows',
    commands: [
      {
        flag: '--flow-etsi-trust-lists',
        label: 'ETSI Trust Lists',
        description: 'ETSI trust list verification flow',
        disabled: true,
        disabledNote: 'Not yet implemented',
      },
      {
        flag: '--flow-credential-revocation',
        label: 'Credential Revocation',
        description: 'Credential revocation flow',
        disabled: true,
        disabledNote: 'Not yet implemented',
      },
    ],
  },
]

export const ALL_COMMANDS = COMMAND_CATEGORIES.flatMap((cat) =>
  cat.commands.map((cmd) => ({ ...cmd, category: cat.id, categoryLabel: cat.label })),
)
