import { TextDecoder } from "node:util";

function requestError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

async function readBuffer(req, maxBytes) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    req.on("data", (chunk) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) {
        fail(requestError("Request body too large", 413));
        return;
      }
      chunks.push(bytes);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, size));
    });
    req.on("error", fail);
  });
}

function decodeUtf8(bytes) {
  try {
    // Decode only after every byte has been collected. Converting individual
    // HTTP chunks to strings corrupts a multibyte character whenever a chunk
    // boundary lands inside its UTF-8 sequence.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw requestError("Request body is not valid UTF-8", 400);
  }
}

export async function readText(req, maxBytes = 4 * 1024 * 1024) {
  return decodeUtf8(await readBuffer(req, maxBytes));
}

export async function readJson(req, maxBytes = 64 * 1024 * 1024) {
  const body = await readText(req, maxBytes);
  try {
    return body ? JSON.parse(body) : {};
  } catch (error) {
    throw Object.assign(error, { statusCode: 400 });
  }
}
