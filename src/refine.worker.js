import { refineMatte } from "./matting.js";

self.onmessage = ({ data }) => {
  try {
    const result = refineMatte(data);
    self.postMessage({ type: "result", ...result }, [result.alpha.buffer, result.rgba.buffer]);
  } catch (error) {
    self.postMessage({ type: "error", message: error.message || "The edges could not be refined. Your current cutout is still available." });
  }
};
