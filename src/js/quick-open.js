// File > Open… (⌘O): which vault files match what the user typed.
//
// Matching works like the [[ note suggestions: case-insensitive, the typed
// text anywhere in the file name, names that start with it first. Typing a
// "/" matches against the path within the vault instead ("draft/intro"), so
// files with the same name in different folders can be told apart.

// `files`: absolute paths; `vault`: the vault folder. Returns at most `limit`
// matches as {path, name, folder}: `name` without ".md" for notes, `folder`
// relative to the vault ("" for the top level).
export function matchVaultFiles(files, vault, query, limit = 50) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const prefix = vault.replace(/\/+$/, "") + "/";
  const byPath = q.includes("/");
  const matches = [];
  for (const path of files) {
    const rel = path.startsWith(prefix) ? path.slice(prefix.length) : path;
    const fileName = rel.split("/").pop();
    const name = fileName.replace(/\.md$/i, "");
    const hay = (byPath ? rel : fileName).toLowerCase();
    const at = hay.indexOf(q);
    if (at < 0) continue;
    // Exact name first, then names starting with the text, then the rest.
    const rank = name.toLowerCase() === q ? 0 : at === 0 ? 1 : 2;
    matches.push({ path, name, folder: rel.slice(0, rel.length - fileName.length).replace(/\/$/, ""), rank });
  }
  matches.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
      a.folder.localeCompare(b.folder),
  );
  return matches.slice(0, limit).map(({ path, name, folder }) => ({ path, name, folder }));
}
