import { NativeModules } from 'react-native';

type NativeJsErrorReporter = {
  report: (
    source: string,
    message: string,
    stack: string | null,
    isFatal: boolean
  ) => void;
  reportFirstRunStarted: () => void;
};

type ErrorHandler = (error: unknown, isFatal?: boolean) => void;

type ErrorUtilsLike = {
  getGlobalHandler?: () => ErrorHandler;
  setGlobalHandler?: (handler: ErrorHandler) => void;
};

type RuntimeGlobal = typeof globalThis & {
  __ONEDAY_JS_ERROR_REPORTER_INSTALLED__?: boolean;
  ErrorUtils?: ErrorUtilsLike;
  RN$handleException?: (
    error: unknown,
    isFatal: boolean,
    reportToConsole: boolean
  ) => boolean | void;
  addEventListener?: (
    type: string,
    listener: (event: { reason?: unknown }) => void
  ) => void;
};

const DEDUPE_WINDOW_MS = 1000;
const MAX_MESSAGE_LENGTH = 32000;

let lastReportKey = '';
let lastReportAt = 0;

function getNativeReporter(): NativeJsErrorReporter | undefined {
  return (NativeModules as { JsErrorReporter?: NativeJsErrorReporter })
    .JsErrorReporter;
}

function stringifyValue(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }

  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeError(error: unknown): { message: string; stack: string | null } {
  if (Array.isArray(error)) {
    return {
      message: error.map(stringifyValue).join(' '),
      stack: null,
    };
  }

  if (error instanceof Error) {
    return {
      message: `${error.name}: ${error.message}`,
      stack: error.stack ?? null,
    };
  }

  const maybeError = error as { message?: unknown; stack?: unknown };
  const message =
    typeof maybeError?.message === 'string'
      ? maybeError.message
      : stringifyValue(error);

  return {
    message,
    stack: typeof maybeError?.stack === 'string' ? maybeError.stack : null,
  };
}

export function reportJsError(
  source: string,
  error: unknown,
  isFatal = false
): void {
  const reporter = getNativeReporter();
  if (!reporter) return;

  const { message, stack } = normalizeError(error);
  const trimmedMessage = message.slice(0, MAX_MESSAGE_LENGTH);
  const reportKey = `${isFatal}:${trimmedMessage}:${stack ?? ''}`;
  const now = Date.now();

  if (
    reportKey === lastReportKey &&
    now - lastReportAt < DEDUPE_WINDOW_MS
  ) {
    return;
  }

  lastReportKey = reportKey;
  lastReportAt = now;

  try {
    reporter.report(source, trimmedMessage, stack, isFatal);
  } catch {
    // The reporter must never become a second source of JS runtime errors.
  }
}

export function reportFirstRunStarted(): void {
  try {
    getNativeReporter()?.reportFirstRunStarted();
  } catch {
    // Runtime telemetry must not affect app startup.
  }
}

export function installJsErrorReporter(): void {
  const runtimeGlobal = globalThis as RuntimeGlobal;
  if (runtimeGlobal.__ONEDAY_JS_ERROR_REPORTER_INSTALLED__) return;
  runtimeGlobal.__ONEDAY_JS_ERROR_REPORTER_INSTALLED__ = true;

  installRnHandleExceptionReporter(runtimeGlobal);
  installErrorUtilsReporter(runtimeGlobal);
  installConsoleErrorReporter();
  installUnhandledRejectionReporter(runtimeGlobal);
}

function installRnHandleExceptionReporter(runtimeGlobal: RuntimeGlobal): void {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(
      runtimeGlobal,
      'RN$handleException'
    );
    const canAssign =
      !descriptor ||
      descriptor.writable === true ||
      typeof descriptor.set === 'function';
    if (!canAssign) return;

    const previousRnHandleException = runtimeGlobal.RN$handleException;
    runtimeGlobal.RN$handleException = (error, isFatal, reportToConsole) => {
      reportJsError('RN$handleException', error, isFatal);
      return (
        previousRnHandleException?.(error, isFatal, reportToConsole) === true
      );
    };
  } catch {
    // Some RN runtimes expose RN$handleException as a read-only native hook.
  }
}

function installErrorUtilsReporter(runtimeGlobal: RuntimeGlobal): void {
  try {
    const errorUtils = runtimeGlobal.ErrorUtils;
    const previousHandler = errorUtils?.getGlobalHandler?.();

    errorUtils?.setGlobalHandler?.((error, isFatal = true) => {
      reportJsError('ErrorUtils', error, isFatal);
      previousHandler?.(error, isFatal);
    });
  } catch {
    // Keep startup alive even if ErrorUtils is unavailable or locked down.
  }
}

function installConsoleErrorReporter(): void {
  try {
    const originalConsoleError = console.error.bind(console);
    console.error = (...args: unknown[]) => {
      reportJsError('console.error', args, false);
      originalConsoleError(...args);
    };
  } catch {
    // Console patching is best-effort.
  }
}

function installUnhandledRejectionReporter(runtimeGlobal: RuntimeGlobal): void {
  try {
    runtimeGlobal.addEventListener?.('unhandledrejection', (event) => {
      reportJsError('unhandledrejection', event.reason ?? event, false);
    });
  } catch {
    // Not every RN runtime exposes browser-style rejection events.
  }
}

installJsErrorReporter();
reportFirstRunStarted();
