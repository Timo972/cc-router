export class CliExitError extends Error {
  readonly exitCode: number;

  constructor(exitCode: number) {
    super(`CLI requested exit ${exitCode}`);
    this.name = "CliExitError";
    this.exitCode = exitCode;
  }
}

export function exitCli(exitCode: number): never {
  throw new CliExitError(exitCode);
}
