import { parseBooleanWithDefault } from "@open-mercato/shared/lib/boolean";

export function isPortalSelfRegistrationAllowed(): boolean {
  return parseBooleanWithDefault(
    process.env.NEXT_PUBLIC_OM_PORTAL_ALLOW_SELF_REGISTRATION,
    true,
  );
}
