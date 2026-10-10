/**
 * Whether two paths name the same note file.
 *
 * The host reports a file under more than one spelling: relative to the vault
 * or absolute, through a symlinked prefix (`/private/tmp` and `/tmp`), with a
 * `file:` scheme or Windows separators. Those all agree on the path's tail, so
 * the comparison is "one path is the other's whole trailing run of segments".
 *
 * The file name alone is never enough: every namespace has its own
 * `README.md`, and treating them as one note let a change meant for another
 * file be applied to the one that happened to be open.
 */

function pathSegments(path: string): string[] {
  const raw = String(path || "")
    .trim()
    .replace(/^file:(?:\/\/)?/i, "")
    .replace(/\\/g, "/");
  const segments: string[] = [];
  for (const segment of raw.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === ".." && segments.length > 0 && segments[segments.length - 1] !== "..") segments.pop();
    else segments.push(segment);
  }
  return segments;
}

export function sameNoteFile(left: string, right: string): boolean {
  const a = pathSegments(left);
  const b = pathSegments(right);
  if (a.length === 0 || b.length === 0) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  // A bare file name says nothing about which directory it is in.
  if (short.length === 1 && long.length > 1) return false;
  const offset = long.length - short.length;
  return short.every((segment, index) => segment === long[offset + index]);
}
