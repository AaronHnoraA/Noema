export function openWikiGitUi(root: string, repositoryId: string): Promise<{
  ok: true;
  type: "wiki-git-ui";
  repositoryId: string;
  url: string;
}>;
export function stopAllWikiGitUis(): Promise<void>;
