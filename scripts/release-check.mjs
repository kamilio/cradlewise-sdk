import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_LICENSE_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_LOCKFILE_BYTES = 16 * 1024 * 1024;
const REVIEWED_DECLARED_LICENSES = new Set([
  "0BSD",
  "APACHE-2.0",
  "BSD-2-CLAUSE",
  "BSD-3-CLAUSE",
  "ISC",
  "MIT",
]);
const REVIEWED_BUNDLED_PARENTS = new Map([
  [
    "toolcraft@0.0.87",
    {
      integrity:
        "sha512-2l0vJmu1+C4zHuDEZi0v8ejL/odHP3yrXFhRt9ep0+sK7wOivH/qNHo2+W86aQkBZbfMe2JiFkfRgrrK6gZfkQ==",
      packages: new Set([
        "toolcraft-design",
        "@poe-code/frontmatter",
        "@poe-code/agent-mcp-config",
        "@poe-code/agent-human-in-loop",
        "@poe-code/task-list",
        "@poe-code/agent-defs",
        "@poe-code/config-mutations",
        "@poe-code/process-runner",
        "tiny-mcp-client",
        "mcp-oauth",
        "auth-store",
      ]),
    },
  ],
]);

const lockfile = await readJsonRegularFile(
  "package-lock.json",
  MAX_LOCKFILE_BYTES,
);
if (
  !isPlainObject(lockfile) ||
  lockfile.lockfileVersion !== 3 ||
  !isPlainObject(lockfile.packages)
) {
  throw new Error(
    "Release blocked: package-lock.json must be a version 3 lockfile with a packages object",
  );
}
const failures = [];
const installationFailures = [];
const packageCache = new Map();
const rootPackage = await readJsonRegularFile(
  "package.json",
  MAX_MANIFEST_BYTES,
);
if (!isPlainObject(rootPackage)) {
  throw new Error("Release blocked: package.json must contain an object");
}
const rootMetadata = lockfile.packages?.[""];
if (!isPlainObject(rootMetadata)) {
  installationFailures.push("package root: invalid lock metadata");
} else if (rootMetadata.hasInstallScript === true) {
  installationFailures.push("package root: package declares an install script");
}
if (
  rootMetadata?.name !== rootPackage.name ||
  rootMetadata?.version !== rootPackage.version
) {
  installationFailures.push(
    `package root: lock=${String(rootMetadata?.name)}@${String(rootMetadata?.version)} installed=${String(rootPackage.name)}@${String(rootPackage.version)}`,
  );
}
if (!(await hasLicenseTerms(".", rootPackage))) {
  failures.push(`${rootPackage.name}@${rootPackage.version}`);
}
for (const [directory, metadata] of Object.entries(lockfile.packages ?? {})) {
  if (!isPlainObject(metadata)) {
    installationFailures.push(
      `${directory || "package root"}: invalid lock metadata`,
    );
    continue;
  }
  if (!directory || metadata?.dev === true || metadata?.link === true) continue;
  if (metadata?.hasInstallScript === true) {
    installationFailures.push(
      `${directory}: production package declares an install script`,
    );
  }
  if (!(await isRealPackageDirectory(directory))) {
    installationFailures.push(
      `${directory}: production package path is not a real directory`,
    );
    continue;
  }
  const dependencyPackage = await readPackage(directory);
  const expectedPackageName = packageNameFromDirectory(directory);
  if (
    typeof dependencyPackage.name !== "string" ||
    dependencyPackage.name.trim().length === 0 ||
    dependencyPackage.name !== expectedPackageName ||
    typeof dependencyPackage.version !== "string" ||
    dependencyPackage.version.trim().length === 0 ||
    metadata?.version !== dependencyPackage.version
  ) {
    installationFailures.push(
      `${directory}: expected=${expectedPackageName}@${String(metadata?.version)} installed=${String(dependencyPackage.name)}@${String(dependencyPackage.version)}`,
    );
  }
  validateReviewedBundle(
    directory,
    metadata,
    dependencyPackage,
    installationFailures,
  );
  const coveredByReviewedBundle =
    metadata?.inBundle === true &&
    (await isCoveredByLicensedBundler(directory, dependencyPackage.name));
  if (!coveredByReviewedBundle && !hasReviewedRegistrySource(metadata)) {
    installationFailures.push(
      `${directory}: production package lacks an official npm registry source and SHA-512 integrity`,
    );
  }
  if (coveredByReviewedBundle) continue;
  if (!(await hasLicenseTerms(directory, dependencyPackage))) {
    failures.push(`${dependencyPackage.name}@${dependencyPackage.version}`);
  }
}

function hasReviewedRegistrySource(metadata) {
  return (
    typeof metadata.resolved === "string" &&
    metadata.resolved.startsWith("https://registry.npmjs.org/") &&
    typeof metadata.integrity === "string" &&
    /^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(metadata.integrity)
  );
}

function packageNameFromDirectory(directory) {
  const marker = directory.lastIndexOf("/node_modules/");
  return directory.slice(
    marker < 0 ? "node_modules/".length : marker + "/node_modules/".length,
  );
}

if (installationFailures.length > 0 || failures.length > 0) {
  const reasons = [];
  if (installationFailures.length > 0) {
    reasons.push(
      `installed production packages do not match package-lock.json: ${[...new Set(installationFailures)].sort().join(", ")}`,
    );
  }
  if (failures.length > 0) {
    reasons.push(
      `production dependency packages lack declared license terms: ${[...new Set(failures)].sort().join(", ")}`,
    );
  }
  throw new Error(`Release blocked: ${reasons.join("; ")}`);
}

console.log(
  "Package and production dependency installation/license checks passed",
);

async function readPackage(directory) {
  let value = packageCache.get(directory);
  if (!value) {
    value = await readJsonRegularFile(
      `${directory}/package.json`,
      MAX_MANIFEST_BYTES,
    );
    packageCache.set(directory, value);
  }
  return value;
}

function isPlainObject(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

async function readJsonRegularFile(path, maximumBytes) {
  const stats = await lstat(path);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    stats.size <= 0 ||
    stats.size > maximumBytes
  ) {
    throw new Error(`Release blocked: ${path} is not a safe regular file`);
  }
  return JSON.parse(await readFile(path, "utf8"));
}

async function isRealPackageDirectory(directory) {
  const parts = directory.split("/");
  if (
    parts[0] !== "node_modules" ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    return false;
  }
  let current = ".";
  try {
    for (const part of parts) {
      current = join(current, part);
      const stats = await lstat(current);
      if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function hasLicenseTerms(directory, dependencyPackage) {
  const entries = await readdir(directory);
  const declaredLicense =
    typeof dependencyPackage.license === "string"
      ? dependencyPackage.license.trim()
      : "";
  const normalizedLicense = declaredLicense.toUpperCase();
  const licenseReference = declaredLicense.match(/^SEE LICENSE IN (.+)$/i);
  if (licenseReference) {
    const filename = licenseReference[1]?.trim();
    if (
      !filename ||
      filename.includes("/") ||
      filename.includes("\\") ||
      !entries.includes(filename)
    ) {
      return false;
    }
    return hasNonemptyRegularFile(directory, filename);
  }
  const licenseFiles = entries.filter((entry) =>
    /^(?:licen[cs]e|copying)(?:\.|$)/i.test(entry),
  );
  let hasLicenseFile = false;
  for (const filename of licenseFiles) {
    if (await hasNonemptyRegularFile(directory, filename)) {
      hasLicenseFile = true;
      break;
    }
  }
  return REVIEWED_DECLARED_LICENSES.has(normalizedLicense) || hasLicenseFile;
}

async function hasNonemptyRegularFile(directory, filename) {
  const path = `${directory}/${filename}`;
  const stats = await lstat(path);
  if (
    !stats.isFile() ||
    stats.nlink !== 1 ||
    stats.size <= 0 ||
    stats.size > MAX_LICENSE_BYTES
  ) {
    return false;
  }
  return (await readFile(path, "utf8")).trim().length > 0;
}

async function isCoveredByLicensedBundler(directory, packageName) {
  const marker = directory.lastIndexOf("/node_modules/");
  if (marker < 0) return false;
  const parentDirectory = directory.slice(0, marker);
  const parentMetadata = lockfile.packages?.[parentDirectory];
  if (
    !parentMetadata ||
    parentMetadata.dev === true ||
    parentMetadata.link === true
  ) {
    return false;
  }
  const parentPackage = await readPackage(parentDirectory);
  const reviewedParent = REVIEWED_BUNDLED_PARENTS.get(
    `${parentPackage.name}@${parentPackage.version}`,
  );
  const bundles =
    parentPackage.bundleDependencies ?? parentPackage.bundledDependencies;
  return (
    reviewedParent !== undefined &&
    parentMetadata.integrity === reviewedParent.integrity &&
    reviewedParent.packages.has(packageName) &&
    Array.isArray(bundles) &&
    bundles.includes(packageName) &&
    (await hasLicenseTerms(parentDirectory, parentPackage))
  );
}

function validateReviewedBundle(
  directory,
  metadata,
  dependencyPackage,
  failures,
) {
  const packageKey = `${dependencyPackage.name}@${dependencyPackage.version}`;
  const reviewedParent = REVIEWED_BUNDLED_PARENTS.get(packageKey);
  if (!reviewedParent) return;
  const bundles =
    dependencyPackage.bundleDependencies ??
    dependencyPackage.bundledDependencies;
  const actual = Array.isArray(bundles) ? bundles : [];
  const actualSet = new Set(actual);
  const expected = [...reviewedParent.packages].sort();
  const normalizedActual = [...actualSet].sort();
  if (
    metadata?.integrity !== reviewedParent.integrity ||
    actual.length !== actualSet.size ||
    normalizedActual.length !== expected.length ||
    normalizedActual.some((name, index) => name !== expected[index])
  ) {
    failures.push(
      `${directory}: reviewed bundle ${packageKey} has unexpected integrity or membership`,
    );
  }
}
