import { config } from "./config.js";

const gradioApi = config.spaceRoot + "/gradio_api";

export async function uploadWav(wav: Buffer): Promise<string> {
  const form = new FormData();
  form.append("files", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "segment.wav");
  const res = await fetch(gradioApi + "/upload", {
    method: "POST",
    headers: { Authorization: "Bearer " + config.hfToken },
    body: form,
  });
  if (!res.ok) throw new Error(`space upload failed: ${res.status}`);
  const data = (await res.json()) as string[];
  if (!Array.isArray(data) || !data[0]) throw new Error("space upload returned no path");
  return data[0];
}

export async function separateOnSpace(path: string, signal?: AbortSignal): Promise<unknown> {
  const joinRes = await fetch(gradioApi + "/call/process", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + config.hfToken },
    body: JSON.stringify({
      data: [{ path, meta: { _type: "gradio.FileData" } }, config.spaceModel],
    }),
    signal,
  });
  const joined = (await joinRes.json()) as { event_id?: string; detail?: string };
  if (!joinRes.ok || !joined.event_id) {
    throw new Error(`space queue join failed: ${joined.detail || joinRes.status}`);
  }

  const stream = await fetch(gradioApi + "/call/process/" + joined.event_id, {
    headers: { Accept: "text/event-stream", Authorization: "Bearer " + config.hfToken },
    signal,
  });
  if (!stream.ok || !stream.body) throw new Error(`space queue failed: ${stream.status}`);

  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let eventName: string | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        const payload = line.slice(5).trim();
        if (eventName === "error") throw new Error("separation failed on the space");
        if (eventName === "complete") return JSON.parse(payload);
        eventName = null;
      }
    }
  }
  throw new Error("space stream ended without a result");
}

export function pickVocals(outputs: unknown): string | null {
  const list = Array.isArray(outputs) ? outputs : [outputs];
  const hit = list.find((f: any) =>
    String(f?.orig_name || f?.path || "").toLowerCase().includes("vocals")
  );
  const file = hit || list[config.vocalsOutputIndex];
  if (!file) return null;
  const url = (file as any).url || config.spaceRoot + "/gradio_api/file=" + (file as any).path;
  return url;
}

export async function fetchVocalsWav(url: string, signal?: AbortSignal): Promise<Buffer> {
  const res = await fetch(url, {
    headers: { Authorization: "Bearer " + config.hfToken },
    signal,
  });
  if (!res.ok) throw new Error(`stem download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
