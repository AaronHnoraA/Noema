// {{file}}
// Created: {{date}}
//
// Note: You may need a build step (tsc) or a runner (tsx/ts-node) to execute this.

export function main(): number {
  {{cursor}}
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

