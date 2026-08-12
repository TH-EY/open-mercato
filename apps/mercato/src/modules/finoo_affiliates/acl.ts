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
    id: "portal.finoo_affiliates.view",
    title: "View Finoo affiliate portal",
    module: "finoo_affiliates",
  },
];

export default features;
