import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { decodeMaybeBase64, redactSecrets } from "../src/utils.js";

describe("property-based safety checks", () => {
  it("redacts secret-shaped keys recursively", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string(),
        fc.string(),
        fc.string(),
        fc.string(),
        async (tokenValue, passwordValue, privateKeyValue, ordinaryValue) => {
          const result = redactSecrets({
            token: tokenValue,
            nested: {
              password: passwordValue,
              privateKey: privateKeyValue,
              note: ordinaryValue,
            },
          }) as {
            token: string;
            nested: { password: string; privateKey: string; note: string };
          };

          expect(result.token).toBe("<redacted>");
          expect(result.nested.password).toBe("<redacted>");
          expect(result.nested.privateKey).toBe("<redacted>");
          expect(result.nested.note).toBe(ordinaryValue);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("round-trips valid base64 payloads back to the original text", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (value) => {
        const encoded = Buffer.from(value, "utf8").toString("base64");
        expect(decodeMaybeBase64(encoded)).toBe(value);
      }),
      { numRuns: 200 },
    );
  });
});
