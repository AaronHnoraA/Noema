/** Source spans shared by table navigation and the live cell layout. */
export function tablePipeOffsets(text: string): number[] {
  const pipes: number[] = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\\") { index++; continue; }
    if (text[index] === "|") pipes.push(index);
  }
  return pipes;
}

export function tableSourceRowParts(text: string): {
  pipes: number[];
  cells: Array<{ from: number; to: number }>;
} {
  const pipes = tablePipeOffsets(text);
  const leading = pipes[0] === 0;
  const trailing = pipes[pipes.length - 1] === text.length - 1;
  const boundaries = [leading ? 1 : 0, ...pipes.slice(leading ? 1 : 0, trailing ? -1 : undefined).map((offset) => offset + 1), text.length - (trailing ? 1 : 0)];
  return {
    pipes,
    cells: boundaries.slice(0, -1).map((from, col) => ({
      from,
      to: col < boundaries.length - 2 ? boundaries[col + 1]! - 1 : boundaries[col + 1]!,
    })),
  };
}
