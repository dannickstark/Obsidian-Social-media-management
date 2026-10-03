import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from "obsidian";
import { pngStructure } from "./png";
import { SecretIds, type Secrets } from "../secrets/secrets";
import type { ImageGenerationRequest } from "./types";

const ENDPOINT = "https://api.openai.com/v1/images/generations";
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_RESPONSE_CHARS = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4096;

type ImageResponse = Pick<RequestUrlResponse, "status" | "text">;

export interface OpenAIImageDeps {
  /** Always reads the current key from Obsidian's device-local SecretStorage. */
  getKey?: () => string | null;
  secrets?: Pick<Secrets, "get">;
  /** Defaults to Obsidian requestUrl; injectable only for deterministic tests. */
  request?: (request: RequestUrlParam) => Promise<ImageResponse>;
}

function cancelled(): Error {
  return new Error("Image generation was cancelled.");
}

async function untilCancelled<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  if (signal.aborted) throw cancelled();
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(cancelled()); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    pending.then((value) => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error); });
  });
}

/** A single image request. It never stores the key, logs response bodies, or creates a note/post. */
export class OpenAIImageClient {
  constructor(private readonly deps: OpenAIImageDeps) {}

  async generate({ prompt, negativePrompt, size, signal }: ImageGenerationRequest): Promise<ArrayBuffer> {
    if (signal?.aborted) throw cancelled();
    const key = this.deps.getKey?.() ?? this.deps.secrets?.get(SecretIds.openaiKey);
    if (!key) throw new Error("Add an OpenAI key in this device's secret storage before generating an image.");
    const trimmed = prompt.trim();
    if (!trimmed || trimmed.length > 4000) throw new Error("The image prompt must contain 1–4000 characters.");
    if (!(["1024x1024", "1024x1536", "1536x1024"] as string[]).includes(size)) throw new Error("Unsupported image size.");
    if (negativePrompt && negativePrompt.length > 1000) throw new Error("Negative guidance is too long.");
    const guidance = negativePrompt?.trim();
    const body = JSON.stringify({ model: "gpt-image-1", prompt: guidance ? `${trimmed}\n\nAvoid: ${guidance}` : trimmed, size, output_format: "png", n: 1 });
    let res: ImageResponse;
    try {
      res = await untilCancelled((this.deps.request ?? requestUrl)({
        url: ENDPOINT, method: "POST", contentType: "application/json", headers: { Authorization: `Bearer ${key}` }, body, throw: false,
      }), signal);
    } catch (error) {
      if (signal?.aborted) throw cancelled();
      // Obsidian's network exception can include request headers or response text.
      void error;
      throw new Error("OpenAI image request failed.");
    }
    if (signal?.aborted) throw cancelled();
    if (res.status < 200 || res.status >= 300) throw new Error(`OpenAI image request failed (HTTP ${res.status}).`);
    if (typeof res.text !== "string" || res.text.length > MAX_RESPONSE_CHARS) throw new Error("OpenAI image response is too large.");
    let encoded: unknown;
    try {
      const parsed: unknown = JSON.parse(res.text);
      encoded = (parsed as { data?: Array<{ b64_json?: unknown }> })?.data?.[0]?.b64_json;
    } catch {
      throw new Error("OpenAI returned an invalid image response.");
    }
    if (typeof encoded !== "string" || !encoded || encoded.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      throw new Error("OpenAI returned an invalid image response.");
    }
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    } catch {
      throw new Error("OpenAI returned an invalid image response.");
    }
    if (!bytes.length || bytes.byteLength > MAX_IMAGE_BYTES || !await pngStructure(bytes)) throw new Error("OpenAI returned an invalid image response.");
    const output = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(output).set(bytes);
    return output;
  }
}
