/** Test transport only: identity comes from this fixture's actual reply. */
export function emitOpeningHeader(
  wire: { channel: { onmessage(event: unknown): void }; openToken: string },
  result: { cwd: string; nativeSessionId: string; connectionId: string },
): void {
  wire.channel.onmessage({
    kind: "sessionOpening",
    openToken: wire.openToken,
    cwd: result.cwd,
    sessionId: result.nativeSessionId,
    connectionId: result.connectionId,
  });
}
