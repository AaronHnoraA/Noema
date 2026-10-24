/** Local, in-place Markdown review blocks shared with server projections. */
export {
  scanEdiffBlocks,
  ediffSide,
  approvedEdiffMarkdown,
  type EdiffBlock,
  type EdiffLine,
} from "../shared/ediff-source.mjs";

import { ediffSide, scanEdiffBlocks } from "../shared/ediff-source.mjs";

export type EdiffAction = "accept" | "reject" | "comment";

/** Compute one exact source edit; both editor surfaces can apply it atomically. */
export function ediffActionEdit(
  source: string, from: number, action: EdiffAction, message = "",
): { from: number; to: number; insert: string } {
  const block = scanEdiffBlocks(source).find((item) => item.from === from);
  if (!block) throw new Error("The proposal changed; review its current location.");
  if (action === "accept") {
    if (block.error) throw new Error(block.error);
    return { from: block.from, to: block.end, insert: ediffSide(block, "new") };
  }
  const firstLineEnd = source.indexOf("\n", block.from);
  if (firstLineEnd < 0) throw new Error("Incomplete review block");
  if (action === "reject") {
    if (block.rejected) throw new Error("This proposal is already rejected");
    return { from: firstLineEnd + 1, to: firstLineEnd + 1, insert: "@@ediff-status rejected\n" };
  }
  const comment = message.trim();
  if (!comment) throw new Error("Write a comment first");
  let at = firstLineEnd + 1;
  while (at < block.to) {
    const end = source.indexOf("\n", at);
    if (end < 0) break;
    const line = source.slice(at, end);
    if (line !== "@@ediff-status rejected" && !line.startsWith("@@ediff-comment ")) break;
    at = end + 1;
  }
  return { from: at, to: at, insert: `@@ediff-comment ${JSON.stringify(comment)}\n` };
}
