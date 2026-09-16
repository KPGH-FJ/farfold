// No generic native text crosses into Session events. Unknown envelopes are kept
// as original notification JSON text in bounded private memory; overflow closes the connection.
// They cannot drive state or be read by a Host/Agent tool. Not durable history storage.
export function createPrivateEnvelopes() {
  const envelopes = [];
  let size = 0;
  return {
    retain(frame, source) {
      const serialized = source ?? JSON.stringify(frame);
      size += Buffer.byteLength(serialized);
      if (envelopes.length >= 128 || size > 1024 * 1024)
        throw Error("Private envelope capacity exceeded");
      envelopes.push(serialized);
    },
    count() {
      return envelopes.length;
    },
  };
}
