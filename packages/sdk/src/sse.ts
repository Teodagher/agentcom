// A minimal Server-Sent Events reader over fetch (works in Node 18+, browsers, Deno, Bun): no EventSource, so the
// client can send an Authorization header.

export type SseEvent = { event: string; data: string; id: string | null };

/** Splits a byte stream into SSE events. Comments (": ping") and events without data are skipped. */
export async function* readSse(body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buf = "";
  let data: string[] = [];
  let event = "message";
  let id: string | null = null;
  const iterable: AsyncIterable<Uint8Array> = Symbol.asyncIterator in body ? (body as AsyncIterable<Uint8Array>) : iterate(body as ReadableStream<Uint8Array>);
  for await (const chunk of iterable) {
    buf += decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.search(/\r?\n/)) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + (buf[i] === "\r" ? 2 : 1));
      if (line === "") {
        if (data.length) yield { event, data: data.join("\n"), id };
        data = [];
        event = "message";
        continue;
      }
      if (line.startsWith(":")) continue;
      const c = line.indexOf(":");
      const field = c === -1 ? line : line.slice(0, c);
      const value = c === -1 ? "" : line.slice(c + 1).replace(/^ /, "");
      if (field === "data") data.push(value);
      else if (field === "event") event = value || "message";
      else if (field === "id") id = value;
    }
  }
}

async function* iterate(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
