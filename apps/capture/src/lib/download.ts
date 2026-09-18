/** Hands the user a file from memory — the manifest is theirs to keep, not the gateway's. */
export function downloadJson(name: string, text: string): void {
  const blob = new Blob([text], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
