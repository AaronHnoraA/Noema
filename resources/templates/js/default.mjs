#!/usr/bin/env node
// {{file}}
// Created: {{date}}

import { fileURLToPath } from "node:url";

function main() {
  {{cursor}}
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] === thisFile) {
  main();
}

