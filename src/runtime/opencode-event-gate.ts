import type { HostRoutedEvent, HostRoutedEventBinding } from "./host-shadow";
import { hostRoutedEventMatchesBinding } from "./host-shadow";
import type { OpenCodeAcpStatus } from "./opencode-acp";
import type { OpenCodeEnvelope } from "./opencode";

export interface OpenCodeEventGateResult {
  accepted: boolean;
  runtimeGeneration: number;
}

export class OpenCodeAcpOpeningEvents {
  private binding: HostRoutedEventBinding | null = null;
  private events: { event: OpenCodeEnvelope; routed: HostRoutedEvent }[] = [];
  private bytes = 0;
  private truncated = false;

  begin(binding: HostRoutedEventBinding): void {
    this.clear();
    this.binding = binding;
  }

  capture(event: OpenCodeEnvelope, routed: HostRoutedEvent): boolean {
    if (
      !this.binding ||
      event.kind !== "acp" ||
      !hostRoutedEventMatchesBinding(routed, this.binding)
    )
      return false;
    const size = JSON.stringify(event).length;
    if (this.events.length >= 512 || this.bytes + size > 8 * 1024 * 1024) {
      this.truncated = true;
      return true;
    }
    this.events.push({ event, routed });
    this.bytes += size;
    return true;
  }

  finish(binding: HostRoutedEventBinding, status: OpenCodeAcpStatus) {
    const events = this.events
      .filter(
        ({ event, routed }) =>
          gateOpenCodeWorkspaceEvent(
            event,
            routed,
            binding,
            status.generation,
            status,
          ).accepted,
      )
      .map(({ event }) => event);
    const truncated = this.truncated;
    this.clear();
    return { events, truncated };
  }

  clear(): void {
    this.binding = null;
    this.events = [];
    this.bytes = 0;
    this.truncated = false;
  }
}

export function gateOpenCodeWorkspaceEvent(
  event: OpenCodeEnvelope,
  routed: HostRoutedEvent,
  binding: HostRoutedEventBinding,
  currentRuntimeGeneration: number,
  currentAcpStatus: OpenCodeAcpStatus | null,
): OpenCodeEventGateResult {
  if (!hostRoutedEventMatchesBinding(routed, binding)) {
    return { accepted: false, runtimeGeneration: currentRuntimeGeneration };
  }
  if (event.kind !== "acp") {
    if (event.generation < currentRuntimeGeneration) {
      return { accepted: false, runtimeGeneration: currentRuntimeGeneration };
    }
    return { accepted: true, runtimeGeneration: event.generation };
  }
  if (
    !currentAcpStatus?.running ||
    routed.runtimeGeneration !== currentAcpStatus.generation ||
    event.generation !== currentAcpStatus.generation
  ) {
    return { accepted: false, runtimeGeneration: currentRuntimeGeneration };
  }
  return { accepted: true, runtimeGeneration: currentRuntimeGeneration };
}
