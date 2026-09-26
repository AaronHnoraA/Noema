export const PROJECT_MANIFEST: string;
export function parseProjectManifest(text: string): {
  repositoryId: string;
  hasProjectTable: boolean;
  projectId: string;
  workspace: string;
};
export function isResearchProjectRootSync(directory: string): boolean;
export function findResearchProjectRoot(start: string): Promise<string>;
export function findResearchProjectRootOrNull(start: string): Promise<string | null>;
export function readProjectLayout(root: string): Promise<{
  root: string;
  id: string;
  workspace: string;
  declaredWorkspace: string;
}>;
