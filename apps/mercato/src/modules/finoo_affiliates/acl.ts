export const features = [
  {
    id: "finoo_affiliates.view",
    title: "View Finoo affiliate data",
    module: "finoo_affiliates",
  },
  {
    id: "finoo_affiliates.manage",
    title: "Manage Finoo affiliates",
    module: "finoo_affiliates",
    dependsOn: ["finoo_affiliates.view"],
  },
  {
    id: "finoo_affiliates.payouts.manage",
    title: "Manage Finoo affiliate payouts",
    module: "finoo_affiliates",
    dependsOn: ["finoo_affiliates.view"],
  },
  {
    id: "portal.finoo_affiliates.view",
    title: "View Finoo affiliate portal",
    module: "finoo_affiliates",
  },
  {
    id: "portal.finoo_affiliates.profile.manage",
    title: "Manage own Finoo affiliate profile",
    module: "finoo_affiliates",
    dependsOn: ["portal.finoo_affiliates.view"],
  },
];

export default features;
