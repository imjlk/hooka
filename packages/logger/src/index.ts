export type LogContext = Record<string, unknown>;

export interface Logger {
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(
    message: string,
    errorOrContext?: Error | LogContext,
    context?: LogContext,
  ): void;
}

export interface LoggerSink {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export function createLogger(input: {
  service: string;
  runtimeRole: string;
  sink?: LoggerSink;
}): Logger {
  const sink = input.sink ?? console;

  function emit(
    level: "info" | "warn" | "error",
    message: string,
    context: LogContext = {},
    error?: Error,
  ): void {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      service: input.service,
      runtimeRole: input.runtimeRole,
      message,
      ...context,
      ...(error
        ? {
            errorMessage: error.message,
            errorStack: error.stack ?? error.message,
          }
        : {}),
    };
    const line = JSON.stringify(entry);

    if (level === "error") {
      sink.error(line);
      return;
    }

    if (level === "warn") {
      sink.warn(line);
      return;
    }

    sink.log(line);
  }

  return {
    info(message, context) {
      emit("info", message, context);
    },
    warn(message, context) {
      emit("warn", message, context);
    },
    error(message, errorOrContext, context) {
      if (errorOrContext instanceof Error) {
        emit("error", message, context, errorOrContext);
        return;
      }

      emit("error", message, errorOrContext);
    },
  };
}
