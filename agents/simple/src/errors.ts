export class NetworkError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = "NetworkError";
  }
}
export class HttpError extends Error {
  constructor(public status: number, public body: string) {
    super(`HTTP ${status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    this.name = "HttpError";
  }
}
export class NoProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoProviderError";
  }
}
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
export class NotImplemented extends Error {
  constructor(what: string) {
    super(`${what} is not implemented`);
    this.name = "NotImplemented";
  }
}
/** The reserve gate failed: nothing was paid. */
export class ReservesFailedError extends Error {
  constructor(public reason: string, public vaultCents: number, public outstandingCents: number) {
    super(reason);
    this.name = "ReservesFailedError";
  }
}
