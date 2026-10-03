import { describe, expect, it, vi } from "vitest";
import { OpenAIImageClient } from "../../src/images/openai";
import { png } from "../media/bytes";
import { validPng } from "./bytes";

const image = validPng(8, 8);
const encoded = Buffer.from(image).toString("base64");
const response = { status: 200, text: JSON.stringify({ data: [{ b64_json: encoded }] }) };

describe("OpenAI image client", () => {
  it("requires the per-device key before sending a request", async () => {
    const request = vi.fn().mockResolvedValue(response);
    await expect(new OpenAIImageClient({ getKey: () => null, request }).generate({ prompt: "A lake", size: "1024x1024" })).rejects.toThrow(/OpenAI key/i);
    expect(request).not.toHaveBeenCalled();
  });

  it("sends a bounded image request and returns PNG bytes", async () => {
    const request = vi.fn().mockResolvedValue(response);
    const bytes = await new OpenAIImageClient({ getKey: () => "secret-key", request }).generate({ prompt: "A lake", negativePrompt: "No text", size: "1536x1024" });
    expect(new Uint8Array(bytes)).toEqual(new Uint8Array(image));
    expect(request).toHaveBeenCalledOnce();
    const sent = request.mock.calls[0]![0];
    expect(sent.url).toBe("https://api.openai.com/v1/images/generations");
    expect(sent.headers.Authorization).toBe("Bearer secret-key");
    expect(JSON.parse(sent.body)).toMatchObject({ model: "gpt-image-1", size: "1536x1024", output_format: "png", prompt: "A lake\n\nAvoid: No text" });
  });

  it("redacts key and provider response on network and API errors", async () => {
    const key = "secret-key";
    const failed = new OpenAIImageClient({ getKey: () => key, request: async () => { throw new Error(`bad ${key}`); } });
    await expect(failed.generate({ prompt: "Lake", size: "1024x1024" })).rejects.toThrow("OpenAI image request failed.");
    const denied = new OpenAIImageClient({ getKey: () => key, request: async () => ({ status: 401, text: `bad ${key}` }) });
    await expect(denied.generate({ prompt: "Lake", size: "1024x1024" })).rejects.toThrow("OpenAI image request failed (HTTP 401).");
  });

  it("rejects malformed, non-image and oversized responses", async () => {
    const make = (text: string) => new OpenAIImageClient({ getKey: () => "key", request: async () => ({ status: 200, text }) });
    await expect(make("not json").generate({ prompt: "Lake", size: "1024x1024" })).rejects.toThrow(/invalid image response/i);
    await expect(make(JSON.stringify({ data: [{ b64_json: Buffer.from("not an image").toString("base64") }] })).generate({ prompt: "Lake", size: "1024x1024" })).rejects.toThrow(/invalid image response/i);
    await expect(make("x".repeat(30_000_000)).generate({ prompt: "Lake", size: "1024x1024" })).rejects.toThrow(/too large/i);
    await expect(make(JSON.stringify({ data: [{ b64_json: Buffer.from(png(8, 8)).toString("base64") }] })).generate({ prompt: "Lake", size: "1024x1024" })).rejects.toThrow(/invalid image response/i);
    await expect(make(JSON.stringify({ data: [{ b64_json: Buffer.from(image.slice(0, -12)).toString("base64") }] })).generate({ prompt: "Lake", size: "1024x1024" })).rejects.toThrow(/invalid image response/i);
    const damaged = new Uint8Array(image.slice(0));
    damaged[damaged.length - 1] = damaged[damaged.length - 1]! ^ 1;
    await expect(make(JSON.stringify({ data: [{ b64_json: Buffer.from(damaged).toString("base64") }] })).generate({ prompt: "Lake", size: "1024x1024" })).rejects.toThrow(/invalid image response/i);
  });

  it("cancels the result even when requestUrl cannot abort the request", async () => {
    const controller = new AbortController();
    let answer!: (value: typeof response) => void;
    const request = () => new Promise<typeof response>((resolve) => { answer = resolve; });
    const pending = new OpenAIImageClient({ getKey: () => "key", request }).generate({ prompt: "Lake", size: "1024x1024", signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/i);
    answer(response);
  });
});
