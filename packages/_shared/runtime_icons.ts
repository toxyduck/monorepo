// Shared file and VCS status presentation, no editor state.
export function fileIcon(path: string): string {
  const icons: Record<string, string> = {kt: "", kts: "", ts: "", tsx: "", js: "", json: "", py: "", rs: "", md: "", sh: "", yaml: "", yml: ""};
  return icons[path.split(".").pop()!.toLowerCase()] || "󰈙";
}
export const statusIcon: Record<string, string> = {added: "+", modified: "M", deleted: "−", renamed: "R", copied: "C", typeChanged: "T", unmerged: "!"};
export const changedLineIcon = {added: '+', modified: '▌', deleted: '−'} as const;
