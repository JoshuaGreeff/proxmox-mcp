import { describe, expect, it } from "vitest";
import { decodeMaybeBase64 } from "../src/utils.js";

describe("decodeMaybeBase64", () => {
  it("returns plain text unchanged", () => {
    expect(decodeMaybeBase64("hello\nuid=0(root)\n")).toBe("hello\nuid=0(root)\n");
  });

  it("decodes valid base64 content", () => {
    expect(decodeMaybeBase64("aGVsbG8=")).toBe("hello");
  });
});
