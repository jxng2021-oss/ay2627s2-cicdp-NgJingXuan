import type { IncomingMessage } from "node:http";
import { Transform } from "node:stream";

export class BodyTooLargeError extends Error {
  constructor() {
    super("Request body is too large");
  }
}

export function limitBody(
  source: IncomingMessage,
  maxBytes: number,
  onTooLarge: () => void,
): Transform {
  let received = 0;
  const limited = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > maxBytes) {
        onTooLarge();
        callback(new BodyTooLargeError());
        return;
      }
      callback(null, chunk);
    },
  });

  source.pipe(limited);
  limited.on("error", () => source.unpipe(limited));
  source.on("close", () => {
    if (!source.readableEnded)
      limited.destroy(new Error("client disconnected"));
  });
  return limited;
}
