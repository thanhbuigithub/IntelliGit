import * as vscode from "vscode";

const REQUEST_TIMEOUT_MS = 45_000;
const MAX_RESPONSE_BYTES = 256_000;
const MAX_EVENT_BYTES = 32_000;

/** Stable failures that cannot expose endpoint credentials or response content. */
export type OpenAiCompatibleErrorKind =
    | "externalConfiguration"
    | "externalAuthentication"
    | "externalRequestFailed"
    | "externalTimeout"
    | "externalInvalidResponse"
    | "cancelled";

/** Safe-to-report error; never retain response bodies, request headers, or network exceptions. */
export class OpenAiCompatibleError extends Error {
    /** Carries only a stable classification, never an external response or its cause. */
    constructor(readonly kind: OpenAiCompatibleErrorKind) {
        super(kind);
        this.name = "OpenAiCompatibleError";
    }
}

/** One already-fitted generation request sent to a configured compatible endpoint. */
export interface OpenAiCompatibleRequest {
    baseUrl: string;
    model: string;
    apiKey: string;
    prompt: string;
    token: vscode.CancellationToken;
}

/** Accepts a user-configured API base URL without ever forwarding credentials on redirects. */
function completionUrl(baseUrl: string): URL {
    let url: URL;
    try {
        url = new URL(baseUrl);
    } catch {
        throw new OpenAiCompatibleError("externalConfiguration");
    }
    if (
        !["http:", "https:"].includes(url.protocol) ||
        !url.hostname ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (!url.pathname.endsWith("/v1") && !url.pathname.endsWith("/v1/"))
    ) {
        throw new OpenAiCompatibleError("externalConfiguration");
    }
    url.pathname = `${url.pathname.replace(/\/$/, "")}/chat/completions`;
    return url;
}

function cancellationError(
    token: vscode.CancellationToken,
    timedOut: boolean,
): OpenAiCompatibleError {
    return new OpenAiCompatibleError(
        token.isCancellationRequested
            ? "cancelled"
            : timedOut
              ? "externalTimeout"
              : "externalRequestFailed",
    );
}

/** Bounds bytes before parsing JSON or SSE, including servers that omit Content-Length. */
async function* boundedChunks(
    body: ReadableStream<Uint8Array>,
    token: vscode.CancellationToken,
    didTimeout: () => boolean,
): AsyncIterable<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let total = 0;
    try {
        while (true) {
            let result: Awaited<ReturnType<typeof reader.read>>;
            try {
                result = await reader.read();
            } catch {
                throw cancellationError(token, didTimeout());
            }
            if (token.isCancellationRequested || didTimeout()) {
                throw cancellationError(token, didTimeout());
            }
            if (result.done) break;
            total += result.value.byteLength;
            if (total > MAX_RESPONSE_BYTES)
                throw new OpenAiCompatibleError("externalInvalidResponse");
            try {
                yield decoder.decode(result.value, { stream: true });
            } catch {
                throw new OpenAiCompatibleError("externalInvalidResponse");
            }
        }
        try {
            yield decoder.decode();
        } catch {
            throw new OpenAiCompatibleError("externalInvalidResponse");
        }
    } finally {
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
}

function decodeJson(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        throw new OpenAiCompatibleError("externalInvalidResponse");
    }
}

function contentOfCompletion(value: unknown, streamed: boolean): string | undefined {
    if (
        !value ||
        typeof value !== "object" ||
        !Array.isArray((value as { choices?: unknown }).choices)
    ) {
        throw new OpenAiCompatibleError("externalInvalidResponse");
    }
    const choices = (value as { choices: unknown[] }).choices;
    if (choices.length === 0 && streamed) return undefined;
    const first = choices[0];
    if (!first || typeof first !== "object")
        throw new OpenAiCompatibleError("externalInvalidResponse");
    const message = (first as Record<string, unknown>)[streamed ? "delta" : "message"];
    if (!message || typeof message !== "object")
        throw new OpenAiCompatibleError("externalInvalidResponse");
    const content = (message as { content?: unknown }).content;
    if (content === null || content === undefined) return undefined;
    if (typeof content !== "string") throw new OpenAiCompatibleError("externalInvalidResponse");
    return content;
}

/** Extracts incremental OpenAI-compatible SSE content, including frames split across reads. */
async function* streamContent(chunks: AsyncIterable<string>): AsyncIterable<string> {
    let pending = "";
    for await (const chunk of chunks) {
        pending += chunk;
        if (Buffer.byteLength(pending, "utf8") > MAX_EVENT_BYTES && !/\r?\n\r?\n/.test(pending)) {
            throw new OpenAiCompatibleError("externalInvalidResponse");
        }
        let match: RegExpExecArray | null;
        while ((match = /\r?\n\r?\n/.exec(pending))) {
            const frame = pending.slice(0, match.index);
            pending = pending.slice(match.index + match[0].length);
            if (Buffer.byteLength(frame, "utf8") > MAX_EVENT_BYTES) {
                throw new OpenAiCompatibleError("externalInvalidResponse");
            }
            const data = frame
                .split(/\r?\n/)
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trimStart())
                .join("\n");
            if (!data) continue;
            if (data === "[DONE]") return;
            const content = contentOfCompletion(decodeJson(data), true);
            if (content) yield content;
        }
    }
    if (pending.trim()) throw new OpenAiCompatibleError("externalInvalidResponse");
}

/** Starts the HTTP request before the host emits start; keeps cancellation active through consumption. */
export async function requestOpenAiCompatibleCommitMessage(
    options: OpenAiCompatibleRequest,
): Promise<AsyncIterable<string>> {
    const url = completionUrl(options.baseUrl);
    if (!options.model.trim() || options.apiKey.includes("\r") || options.apiKey.includes("\n")) {
        throw new OpenAiCompatibleError("externalConfiguration");
    }
    if (options.token.isCancellationRequested) throw new OpenAiCompatibleError("cancelled");
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, REQUEST_TIMEOUT_MS);
    let response: Response | undefined;
    const subscription = options.token.onCancellationRequested(() => {
        controller.abort();
        clearTimeout(timeout);
        void response?.body?.cancel().catch(() => undefined);
    });
    const dispose = () => {
        clearTimeout(timeout);
        subscription.dispose();
    };
    try {
        response = await fetch(url.toString(), {
            method: "POST",
            redirect: "error",
            signal: controller.signal,
            headers: {
                "Content-Type": "application/json",
                ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
            },
            body: JSON.stringify({
                model: options.model,
                messages: [{ role: "user", content: options.prompt }],
                stream: true,
            }),
        });
    } catch {
        dispose();
        throw cancellationError(options.token, timedOut);
    }
    if (options.token.isCancellationRequested || timedOut) {
        dispose();
        await response.body?.cancel().catch(() => undefined);
        throw cancellationError(options.token, timedOut);
    }
    if (!response.ok || !response.body) {
        dispose();
        await response.body?.cancel().catch(() => undefined);
        throw new OpenAiCompatibleError(
            response.status === 401 || response.status === 403
                ? "externalAuthentication"
                : "externalRequestFailed",
        );
    }
    const text = (async function* (): AsyncIterable<string> {
        try {
            const chunks = boundedChunks(response.body!, options.token, () => timedOut);
            if (response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
                yield* streamContent(chunks);
            } else {
                let body = "";
                for await (const chunk of chunks) body += chunk;
                const content = contentOfCompletion(decodeJson(body), false);
                if (content) yield content;
            }
        } catch (error) {
            if (error instanceof OpenAiCompatibleError) throw error;
            throw cancellationError(options.token, timedOut);
        } finally {
            dispose();
            controller.abort();
        }
    })();
    return text;
}
