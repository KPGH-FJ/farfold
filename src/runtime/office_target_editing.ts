import type { VerifiedFile } from "./file_delivery";

/** Transient selection editing delays replacement; it never proves a target. */
export type OfficeTargetEditing = Readonly<{
  owner: object;
  file: Readonly<VerifiedFile>;
  editing: boolean;
}>;
