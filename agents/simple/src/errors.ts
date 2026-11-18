import type { ReserveCheckResult } from "@blindfold/protocol";

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
/** The reserve gate failed: nothing was paid. */
export class ReservesFailedError extends Error {
  constructor(public reserves: ReserveCheckResult) {
    super(reserves.reason ?? "reserve check failed");
    this.name = "ReservesFailedError";
  }
}
