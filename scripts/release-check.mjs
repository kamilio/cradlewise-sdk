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
    "toolcraft@0.0.109",
    {
      integrity:
        "sha512-dDglsvnwTxMZ91NJzZvCV7lg1LgP67E5M3h/yHWggAEVHUDCsegg1/zwSUAuVv09dVaPHhMAlybeumHZNaI7Ag==",
      composition: "dist/composition.json",
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
const bundleCache = new Map();
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
  const installedDirectory = await resolveInstalledPackageDirectory(
    directory,
    metadata,
  );
  if (!installedDirectory) {
    installationFailures.push(
      `${directory}: production package path is not a real directory`,
    );
    continue;
  }
  const dependencyPackage = await readPackage(installedDirectory);
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
  await validateReviewedBundle(
    installedDirectory,
    metadata,
    dependencyPackage,
    installationFailures,
  );
  const coveredByReviewedBundle =
    installedDirectory === directory &&
    metadata?.inBundle === true &&
    (await isCoveredByLicensedBundler(directory, dependencyPackage.name));
  if (!coveredByReviewedBundle && !hasReviewedRegistrySource(metadata)) {
    installationFailures.push(
      `${directory}: production package lacks an official npm registry source and SHA-512 integrity`,
    );
  }
  if (coveredByReviewedBundle) continue;
  if (!(await hasLicenseTerms(installedDirectory, dependencyPackage))) {
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

async function resolveInstalledPackageDirectory(directory, metadata) {
  if (await isRealPackageDirectory(directory)) return directory;
  if (metadata?.inBundle !== true) return undefined;

  const packageName = packageNameFromDirectory(directory);
  let parentDirectory = directory.slice(
    0,
    directory.lastIndexOf("/node_modules/"),
  );
  while (parentDirectory.startsWith("node_modules/")) {
    const marker = parentDirectory.lastIndexOf("/node_modules/");
    const candidate =
      marker < 0
        ? join("node_modules", packageName)
        : join(parentDirectory.slice(0, marker), "node_modules", packageName);
    const candidateMetadata = lockfile.packages?.[candidate];
    if (
      isPlainObject(candidateMetadata) &&
      candidateMetadata.dev !== true &&
      candidateMetadata.link !== true &&
      candidateMetadata.version === metadata.version &&
      candidateMetadata.resolved === metadata.resolved &&
      candidateMetadata.integrity === metadata.integrity &&
      (await isRealPackageDirectory(candidate))
    ) {
      return candidate;
    }
    if (marker < 0) break;
    parentDirectory = parentDirectory.slice(0, marker);
  }
  return undefined;
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
  let reviewedBundle;
  try {
    reviewedBundle = await readReviewedBundle(
      parentDirectory,
      parentMetadata,
      parentPackage,
    );
  } catch {
    return false;
  }
  const bundles =
    parentPackage.bundleDependencies ?? parentPackage.bundledDependencies;
  const bundledPackage = reviewedBundle?.packages.get(packageName);
  const dependencyPackage = await readPackage(directory);
  return (
    reviewedBundle !== undefined &&
    bundledPackage?.version === dependencyPackage.version &&
    REVIEWED_DECLARED_LICENSES.has(bundledPackage.license.toUpperCase()) &&
    Array.isArray(bundles) &&
    bundles.includes(packageName) &&
    (await hasLicenseTerms(parentDirectory, parentPackage))
  );
}

async function validateReviewedBundle(
  directory,
  metadata,
  dependencyPackage,
  failures,
) {
  const packageKey = `${dependencyPackage.name}@${dependencyPackage.version}`;
  const reviewedParent = REVIEWED_BUNDLED_PARENTS.get(packageKey);
  if (!reviewedParent) return;
  try {
    await readReviewedBundle(directory, metadata, dependencyPackage);
  } catch {
    failures.push(
      `${directory}: reviewed bundle ${packageKey} has unexpected integrity, composition, or membership`,
    );
  }
}

async function readReviewedBundle(directory, metadata, dependencyPackage) {
  if (bundleCache.has(directory)) return bundleCache.get(directory);
  const packageKey = `${dependencyPackage.name}@${dependencyPackage.version}`;
  const reviewedParent = REVIEWED_BUNDLED_PARENTS.get(packageKey);
  if (!reviewedParent) return undefined;
  if (metadata?.integrity !== reviewedParent.integrity) {
    throw new Error("Reviewed bundle integrity changed");
  }
  const composition = await readJsonRegularFile(
    join(directory, reviewedParent.composition),
    MAX_MANIFEST_BYTES,
  );
  if (
    !isPlainObject(composition) ||
    composition.schemaVersion !== 1 ||
    !Array.isArray(composition.packages)
  ) {
    throw new Error("Reviewed bundle composition is invalid");
  }
  const packages = new Map();
  for (const value of composition.packages) {
    if (
      !isPlainObject(value) ||
      typeof value.name !== "string" ||
      value.name.length === 0 ||
      typeof value.version !== "string" ||
      value.version.length === 0 ||
      typeof value.license !== "string" ||
      value.license.length === 0 ||
      packages.has(value.name)
    ) {
      throw new Error("Reviewed bundle composition package is invalid");
    }
    packages.set(value.name, {
      version: value.version,
      license: value.license,
    });
  }
  const parentComposition = packages.get(dependencyPackage.name);
  if (
    parentComposition?.version !== dependencyPackage.version ||
    parentComposition.license.toUpperCase() !==
      String(dependencyPackage.license).toUpperCase()
  ) {
    throw new Error("Reviewed bundle parent composition changed");
  }
  const bundles =
    dependencyPackage.bundleDependencies ??
    dependencyPackage.bundledDependencies;
  const actual = Array.isArray(bundles) ? bundles : [];
  const actualSet = new Set(actual);
  const expected = [...packages.keys()]
    .filter((name) => name !== dependencyPackage.name)
    .sort();
  const normalizedActual = [...actualSet].sort();
  if (
    actual.length !== actualSet.size ||
    normalizedActual.length !== expected.length ||
    normalizedActual.some((name, index) => name !== expected[index])
  ) {
    throw new Error("Reviewed bundle membership changed");
  }
  for (const name of expected) {
    const childDirectory = join(directory, "node_modules", name);
    const childMetadata = lockfile.packages?.[childDirectory];
    const childPackage = await readPackage(childDirectory);
    const expectedPackage = packages.get(name);
    if (
      childMetadata?.inBundle !== true ||
      childMetadata.version !== expectedPackage.version ||
      childPackage.name !== name ||
      childPackage.version !== expectedPackage.version
    ) {
      throw new Error("Reviewed bundle package changed");
    }
  }
  const reviewedBundle = Object.freeze({ packages });
  bundleCache.set(directory, reviewedBundle);
  return reviewedBundle;
}
