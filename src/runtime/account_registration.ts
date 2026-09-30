import { officialLink, type PreparationLink } from "./preparation";

/** A non-secret page position, never an authentication result. */
export interface AccountRegistrationProgress {
  methodId: string;
  url: string;
  page: "choose" | "external" | "returned";
}
export function parseAccountRegistration(
  value: unknown,
  methodId?: string,
): AccountRegistrationProgress | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  if (
    record.methodId !== (methodId ?? "") ||
    typeof record.url !== "string" ||
    !["choose", "external", "returned"].includes(String(record.page)) ||
    (record.url !== "" && !officialLink(record.url)) ||
    (record.url === "" && record.page !== "choose")
  )
    return;
  return {
    methodId: record.methodId as string,
    url: record.url,
    page: record.page as AccountRegistrationProgress["page"],
  };
}
export function currentAccountRegistration(
  value: AccountRegistrationProgress | undefined,
  methodId: string | undefined,
  links: PreparationLink[],
): AccountRegistrationProgress | undefined {
  if (!value) return;
  const valid = parseAccountRegistration(value, methodId);
  if (
    !valid ||
    (valid.url &&
      !links.some((link) => link.kind === "account" && link.url === valid.url))
  )
    return { methodId: methodId ?? "", url: "", page: "choose" };
  return valid;
}
