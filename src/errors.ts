export const ExitCode = {
  success: 0,
  usage: 2,
  validation: 3,
  authentication: 4,
  conflict: 5,
  network: 6,
  partialApply: 7,
  unexpected: 1,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export class TidekeeperError extends Error {
  public constructor(
    message: string,
    public readonly exitCode: ExitCodeValue,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ValidationError extends TidekeeperError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, ExitCode.validation, options);
  }
}

export class AuthenticationError extends TidekeeperError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, ExitCode.authentication, options);
  }
}

export class ConflictError extends TidekeeperError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, ExitCode.conflict, options);
  }
}

export class NetworkError extends TidekeeperError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, ExitCode.network, options);
  }
}

export class PartialApplyError extends TidekeeperError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, ExitCode.partialApply, options);
  }
}
