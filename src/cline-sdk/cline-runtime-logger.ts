import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ClineSdkBasicLogger as BasicLogger, resolveClineSdkDataDir } from "./sdk-runtime-boundary.js";

type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

const DEFAULT_LOG_NAME = "kanban";
const DEFAULT_LOG_PATH = join(resolveClineSdkDataDir(), "logs", `${DEFAULT_LOG_NAME}.log`);

function normalizeLogLevel(value: string | undefined): LogLevel {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "debug" || normalized === "info" || normalized === "warn" || normalized === "error") {
		return normalized;
	}
	return "info";
}

function normalizeLogPath(): string {
	const configured = process.env.CLINE_LOG_PATH?.trim();
	return configured && configured.length > 0 ? configured : DEFAULT_LOG_PATH;
}

function isLoggingEnabled(): boolean {
	const configured = process.env.CLINE_LOG_ENABLED?.trim().toLowerCase();
	if (configured === undefined) {
		return false;
	}
	return configured === "1" || configured === "true" || configured === "yes" || configured === "on";
}

function writeLogLine(level: LogLevel, message: string, metadata?: Record<string, unknown>): void {
	if (!isLoggingEnabled()) {
		return;
	}
	const line = JSON.stringify({
		ts: new Date().toISOString(),
		level,
		message,
		...(metadata ? { metadata } : {}),
	});
	try {
		const destination = normalizeLogPath();
		mkdirSync(dirname(destination), { recursive: true });
		appendFileSync(destination, `${line}\n`, "utf8");
	} catch {
		// Best-effort logging only.
	}
}

const CONSOLE_METHOD: Record<LogLevel, (...args: unknown[]) => void> = {
	debug: console.debug,
	info: console.info,
	warn: console.warn,
	error: console.error,
};

function logToConsole(level: LogLevel, message: string, metadata?: Record<string, unknown>): void {
	// Gated by the same CLINE_LOG_ENABLED master switch as file logging.
	if (!isLoggingEnabled()) {
		return;
	}
	const prefix = `[cline:${level}]`;
	if (metadata) {
		CONSOLE_METHOD[level](prefix, message, metadata);
	} else {
		CONSOLE_METHOD[level](prefix, message);
	}
}

export function createKanbanClineLogger(bindings?: Record<string, unknown>): BasicLogger {
	const minLevel = normalizeLogLevel(process.env.CLINE_LOG_LEVEL);
	const shouldLog = (level: LogLevel) => LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[minLevel];
	const emit = (level: LogLevel, message: string, metadata?: Record<string, unknown>) => {
		if (!shouldLog(level)) {
			return;
		}
		const mergedMetadata =
			bindings || metadata
				? {
						...(bindings ?? {}),
						...(metadata ?? {}),
					}
				: undefined;
		writeLogLine(level, message, mergedMetadata);
		logToConsole(level, message, mergedMetadata);
	};

	return {
		debug: (message: string, metadata?: Record<string, unknown>) => emit("debug", message, metadata),
		log: (message: string, metadata?: Record<string, unknown>) => {
			const severity = (metadata as { severity?: string } | undefined)?.severity;
			if (severity === "warn") {
				emit("warn", message, metadata);
			} else {
				emit("info", message, metadata);
			}
		},
		error: (message: string, metadata?: Record<string, unknown>) => emit("error", message, metadata),
	};
}

// Shared process-wide runtime logger. Prefer this over ad-hoc
// createKanbanClineLogger() calls for server/trpc/state instrumentation so all
// runtime logs share one configuration and honor the CLINE_LOG_ENABLED switch.
let sharedRuntimeLogger: BasicLogger | null = null;

export function getKanbanRuntimeLogger(): BasicLogger {
	if (!sharedRuntimeLogger) {
		sharedRuntimeLogger = createKanbanClineLogger({ runtime: "kanban" });
	}
	return sharedRuntimeLogger;
}

// Create a logger that merges the shared runtime bindings with caller-provided
// context (e.g. workspaceId, component). Useful for per-request/per-workspace
// scoping while keeping a single logging pipeline.
export function createScopedRuntimeLogger(bindings: Record<string, unknown>): BasicLogger {
	return createKanbanClineLogger({ runtime: "kanban", ...bindings });
}
