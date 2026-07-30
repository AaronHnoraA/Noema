// Ported from @nteract/messaging (BSD-3-Clause) src/wire-protocol.ts.
// Jupyter wire-protocol multipart encode/decode with HMAC-SHA256 signing.
//
// Copyright (c) 2016, nteract contributors
// All rights reserved.
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the conditions of the
// BSD-3-Clause license are met (see https://github.com/nteract/nteract).

import crypto from "node:crypto";

const WIRE_PROTOCOL_DELIMITER = "<IDS|MSG>";

// idents..., delimiter, signature, header, parent_header, metadata, content, buffers...
const REQUIRED_NUMBER_OF_MESSAGE_FRAMES = 5;

function toJSON(value) {
  return JSON.parse(value.toString());
}

function initializeMessage(message) {
  return Object.assign(
    { header: {}, parent_header: {}, metadata: {}, content: {}, idents: [], buffers: [] },
    message,
  );
}

// Only sha256 is supported (all Jupyter uses it nowadays); accepts the
// Pythonic "hmac-sha256" spelling too.
function identifyHmacScheme(scheme) {
  return scheme === "hmac-sha256" ? "sha256" : scheme;
}

/**
 * Decode raw ZMQ message frames into a Jupyter message object, verifying the
 * HMAC signature when `key` is given.
 */
export function decode(messageFrames, key, scheme = "sha256") {
  let i = 0;
  const idents = [];
  for (; i < messageFrames.length; i++) {
    if (messageFrames[i].toString() === WIRE_PROTOCOL_DELIMITER) break;
    idents.push(messageFrames[i]);
  }

  if (messageFrames.length - i < REQUIRED_NUMBER_OF_MESSAGE_FRAMES) {
    throw new Error("Message Decoding: Not enough message frames");
  }
  if (messageFrames[i].toString() !== WIRE_PROTOCOL_DELIMITER) {
    throw new Error("Message Decoding: Missing delimiter");
  }

  if (key) {
    const hmacScheme = identifyHmacScheme(scheme);
    const obtainedSignature = messageFrames[i + 1].toString();
    const hmac = crypto.createHmac(hmacScheme, key);
    hmac.update(messageFrames[i + 2]);
    hmac.update(messageFrames[i + 3]);
    hmac.update(messageFrames[i + 4]);
    hmac.update(messageFrames[i + 5]);
    const expectedSignature = hmac.digest("hex");
    if (expectedSignature !== obtainedSignature) {
      throw new Error(
        `Message Decoding: Incorrect;\nObtained "${obtainedSignature}"\nExpected "${expectedSignature}"`,
      );
    }
  }

  return initializeMessage({
    idents,
    header: toJSON(messageFrames[i + 2]),
    parent_header: toJSON(messageFrames[i + 3]),
    content: toJSON(messageFrames[i + 5]),
    metadata: toJSON(messageFrames[i + 4]),
    buffers: Array.prototype.slice.call(messageFrames, i + 6),
  });
}

/**
 * Encode a Jupyter message object into raw ZMQ multipart frames, signing with
 * HMAC when `key` is given.
 */
export function encode(_message, key, scheme = "sha256") {
  const message = initializeMessage(_message);
  const hmacScheme = identifyHmacScheme(scheme);
  const idents = message.idents;

  const header = Buffer.from(JSON.stringify(message.header), "utf-8");
  const parentHeader = Buffer.from(JSON.stringify(message.parent_header), "utf-8");
  const metadata = Buffer.from(JSON.stringify(message.metadata), "utf-8");
  const content = Buffer.from(JSON.stringify(message.content), "utf-8");

  let signature = "";
  if (key) {
    const hmac = crypto.createHmac(hmacScheme, key);
    hmac.update(header);
    hmac.update(parentHeader);
    hmac.update(metadata);
    hmac.update(content);
    signature = hmac.digest("hex");
  }

  return idents
    .concat([
      Buffer.from(WIRE_PROTOCOL_DELIMITER),
      Buffer.from(signature),
      header,
      parentHeader,
      metadata,
      content,
    ])
    .concat(message.buffers);
}
