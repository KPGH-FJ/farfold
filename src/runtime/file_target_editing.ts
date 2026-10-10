import type { VerifiedFile } from "./file_delivery";

/** Editing delays replacement; this transient owner never proves a target. */
export type FileTargetEditing = Readonly<{
  owner: object;
  file: Readonly<VerifiedFile>;
  editing: boolean;
}>;
