export const features = [
  {
    id: 'finoo_intermediaries.view',
    title: 'View FINOO intermediary assignments',
    module: 'finoo_intermediaries',
  },
  {
    id: 'finoo_intermediaries.manage',
    title: 'Manage FINOO intermediary assignments',
    module: 'finoo_intermediaries',
    dependsOn: ['finoo_intermediaries.view'],
  },
  {
    id: 'portal.finoo_intermediaries.view',
    title: 'View assigned FINOO intermediary deals',
    module: 'finoo_intermediaries',
  },
]

export default features
