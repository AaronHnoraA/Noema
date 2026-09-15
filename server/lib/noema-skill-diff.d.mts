export function createSkillDiff(base: string, edited: string): Promise<string>;
export function applySkillDiff(base: string, diff: string, expectedHash: string): Promise<string>;
