export const features = [
  {
    id: 'finoo_identities.view',
    title: 'View FINOO identity data',
    module: 'finoo_identities',
  },
  {
    id: 'finoo_identities.manage',
    title: 'Manage FINOO identity data',
    module: 'finoo_identities',
    dependsOn: ['finoo_identities.view'],
  },
]

export default features
