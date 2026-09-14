import { existsSync, lstatSync, rmSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDirectory = resolve(repositoryRoot, "dist");
const expectedDistDirectory = join(repositoryRoot, "dist");

if (distDirectory !== expectedDistDirectory
  || dirname(distDirectory) !== repositoryRoot
  || distDirectory === parse(distDirectory).root) {
  throw new Error(`Refusing to clean unexpected build directory: ${distDirectory}`);
}

if (existsSync(distDirectory)) {
  const status = lstatSync(distDirectory);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error(`Refusing to clean non-directory build path: ${distDirectory}`);
  }
  rmSync(distDirectory, { recursive: true, force: false });
}
