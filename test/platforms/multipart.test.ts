import { describe, expect, it } from "vitest";
import { multipart } from "../../src/platforms/multipart";
import { parseForm } from "./http";

describe("multipart", () => {
  it("encodes text fields and files with their names and types", () => {
    const photo = new Uint8Array([1, 2, 3, 13, 10]).buffer;
    const { body, contentType } = multipart(
      [
        { name: "chat_id", value: "@eventx" },
        { name: "caption", value: "Café 👋" },
        { name: "photo", filename: "cover.png", contentType: "image/png", data: photo },
      ],
      "b0undary",
    );
    expect(contentType).toBe("multipart/form-data; boundary=b0undary");
    expect(parseForm(body, contentType)).toEqual({
      chat_id: { value: "@eventx", size: 7 },
      caption: { value: "Café 👋", size: 10 },
      photo: { filename: "cover.png", type: "image/png", size: 5 },
    });
  });

  it("writes the exact bytes of the form, file data untouched", () => {
    const { body } = multipart([{ name: "a", value: "1" }, { name: "f", filename: "x.bin", contentType: "application/octet-stream", data: new Uint8Array([0, 255, 13, 10]).buffer }], "B");
    const bytes = new Uint8Array(body);
    const head = new TextEncoder().encode('--B\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--B\r\nContent-Disposition: form-data; name="f"; filename="x.bin"\r\nContent-Type: application/octet-stream\r\n\r\n');
    const tail = new TextEncoder().encode("\r\n--B--\r\n");
    expect(Array.from(bytes)).toEqual([...head, 0, 255, 13, 10, ...tail]);
  });

  it("uses a fresh random boundary by default", () => {
    const a = multipart([{ name: "a", value: "1" }]).contentType;
    const b = multipart([{ name: "a", value: "1" }]).contentType;
    expect(a).toMatch(/^multipart\/form-data; boundary=osmm-[a-z0-9]{24}$/);
    expect(a).not.toBe(b);
  });

  it("never lets a name or file name break the part header", () => {
    const { body, contentType } = multipart([
      { name: 'a"b', value: "x" },
      { name: "f", filename: 'x"\r\n.png', contentType: "image/png", data: new Uint8Array([1]).buffer },
    ]);
    expect(parseForm(body, contentType)).toEqual({ a_b: { value: "x", size: 1 }, f: { filename: "x___.png", type: "image/png", size: 1 } });
  });
});
