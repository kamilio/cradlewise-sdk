const ALLOWED_ENVIRONMENT = new Set([
  "APPDATA",
  "COLORTERM",
  "COMSPEC",
  "FORCE_COLOR",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LOCALAPPDATA",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "USERPROFILE",
  "WINDIR",
]);

export function reviewedChildEnvironment(
  environment = {},
  { platform = process.platform } = {},
) {
  const sanitized = Object.create(null);
  for (const [name, value] of Object.entries(environment)) {
    const normalizedName = platform === "win32" ? name.toUpperCase() : name;
    if (
      (ALLOWED_ENVIRONMENT.has(normalizedName) ||
        normalizedName.startsWith("LC_")) &&
      typeof value === "string"
    ) {
      sanitized[normalizedName] = value;
    }
  }
  return sanitized;
}
