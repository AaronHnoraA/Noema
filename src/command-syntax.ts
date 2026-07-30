export {
  isBlockCommandCloseLine,
  findInlineCommandClose,
  parseBlockCommandOpenLine,
  parseBlockCommandText,
  parseCommandArgs,
  scanInlineCommands,
} from "../shared/command-syntax.mjs";

export type { BlockCommand, InlineCommand } from "../shared/command-syntax.mjs";
