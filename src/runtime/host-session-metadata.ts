import { invoke } from "@tauri-apps/api/core";
import {
  replaceHostNavigation,
  type HostNavigationSnapshot,
} from "./host-shadow";

export interface HostSessionMetadata {
  farfoldSessionId: string;
  title: string;
  titleSource: "native" | "first_user" | "manual";
  pinned: boolean;
  archivedAt: number | null;
  updatedAt: number;
}

export interface UpdateHostSessionMetadataInput {
  farfoldSessionId: string;
  title?: string;
  pinned?: boolean;
  archived?: boolean;
}

export async function updateHostSessionMetadata(
  input: UpdateHostSessionMetadataInput,
): Promise<HostSessionMetadata> {
  const result = await invoke<{
    metadata: HostSessionMetadata;
    navigation: HostNavigationSnapshot;
  }>("session_metadata_update", { input });
  replaceHostNavigation(result.navigation);
  return result.metadata;
}
