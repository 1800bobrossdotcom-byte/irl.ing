import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const expected =
  "309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8";
const bytes = await readFile(
  new URL("../public/models/u2netp.onnx", import.meta.url),
);
if (createHash("sha256").update(bytes).digest("hex") !== expected) {
  throw new Error("The bundled U²-Net model failed its integrity check.");
}
console.log("U²-Net model integrity verified.");
