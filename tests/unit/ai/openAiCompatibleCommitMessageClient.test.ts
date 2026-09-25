import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({}));

import {
    OpenAiCompatibleError,
    requestOpenAiCompatibleCommitMessage,
} from "../../../src/ai/openAiCompatibleCommitMessageClient";

type TestToken = {
    isCancellationRequested: boolean;
    onCancellationRequested(listener: () => void): { dispose(): void };
};

function token(): TestToken {
    const listeners = new Set<() => void>();
    return {
        isCancellationRequested: false,
        onCancellationRequested(listener) {
            listeners.add(listener);
            return { dispose: () => listeners.delete(listener) };
        },
    };
}

function response(
    body: BodyInit | null,
    options: { status?: number; contentType?: string } = {},
): Response {
    return new Response(body, {
        status: options.status ?? 200,
        headers: options.contentType ? { "content-type": options.contentType } : undefined,
    });
}

function streamedResponse(chunks: string[], contentType = "text/event-stream"): Response {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
        },
    });
    return new Response(body, { headers: { "content-type": contentType } });
}

function options(
    overrides: Partial<Parameters<typeof requestOpenAiCompatibleCommitMessage>[0]> = {},
) {
    return {
        baseUrl: "https://example.test/v1/",
        model: "gpt-test",
        apiKey: "secret-token",
        prompt: "Generate a commit message.",
        token: token(),
        ...overrides,
    };
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("requestOpenAiCompatibleCommitMessage", () => {
    it("posts the configured request and streams SSE content across read boundaries", async () => {
        fetchMock.mockResolvedValue(
            streamedResponse([
                'data: {"choices":[{"delta":{"content":"fix: ',
                '"}}]}\n\n',
                'data: {"choices":[{"delta":{"content":"external"}}]}\n\n',
                "data: [DONE]\n\n",
            ]),
        );

        const output = await requestOpenAiCompatibleCommitMessage(options());

        expect(fetchMock).toHaveBeenCalledOnce();
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe("https://example.test/v1/chat/completions");
        expect(init).toMatchObject({
            method: "POST",
            redirect: "error",
            headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer secret-token",
            },
        });
        expect(JSON.parse(String(init?.body))).toEqual({
            model: "gpt-test",
            messages: [{ role: "user", content: "Generate a commit message." }],
            stream: true,
        });
        await expect(Array.fromAsync(output)).resolves.toEqual(["fix: ", "external"]);
    });

    it("supports non-streaming JSON completion responses", async () => {
        fetchMock.mockResolvedValue(
            response(
                JSON.stringify({
                    choices: [{ message: { content: "fix: json fallback" } }],
                }),
                { contentType: "application/json" },
            ),
        );

        const output = await requestOpenAiCompatibleCommitMessage(options());

        await expect(Array.fromAsync(output)).resolves.toEqual(["fix: json fallback"]);
    });

    it.each([401, 403])("maps HTTP %s to externalAuthentication", async (status) => {
        fetchMock.mockResolvedValue(response("not exposed", { status }));

        await expect(requestOpenAiCompatibleCommitMessage(options())).rejects.toMatchObject({
            kind: "externalAuthentication",
        });
    });

    it("maps other non-success HTTP responses without exposing the response body", async () => {
        fetchMock.mockResolvedValue(response("secret provider details", { status: 502 }));

        const failure = await requestOpenAiCompatibleCommitMessage(options()).catch(
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(OpenAiCompatibleError);
        expect(failure).toMatchObject({ kind: "externalRequestFailed" });
        expect(failure).not.toHaveProperty("message", expect.stringContaining("secret provider"));
    });

    it.each([
        "not-a-url",
        "https://user:password@example.test/v1",
        "https://example.test/v1?token=secret",
        "https://example.test/api",
    ])("rejects unsafe or unsupported base URL %s before making a request", async (baseUrl) => {
        await expect(
            requestOpenAiCompatibleCommitMessage(options({ baseUrl })),
        ).rejects.toMatchObject({ kind: "externalConfiguration" });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects blank models and newline-bearing API keys as externalConfiguration", async () => {
        await expect(
            requestOpenAiCompatibleCommitMessage(options({ model: "   " })),
        ).rejects.toMatchObject({ kind: "externalConfiguration" });
        await expect(
            requestOpenAiCompatibleCommitMessage(options({ apiKey: "secret\nforged" })),
        ).rejects.toMatchObject({ kind: "externalConfiguration" });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("maps malformed JSON and malformed SSE frames to externalInvalidResponse", async () => {
        fetchMock.mockResolvedValue(response("{malformed", { contentType: "application/json" }));
        const invalidJson = await requestOpenAiCompatibleCommitMessage(options());
        await expect(Array.fromAsync(invalidJson)).rejects.toMatchObject({
            kind: "externalInvalidResponse",
        });

        fetchMock.mockResolvedValue(streamedResponse(['data: {"choices":[]}']));
        const invalidSse = await requestOpenAiCompatibleCommitMessage(options());
        await expect(Array.fromAsync(invalidSse)).rejects.toMatchObject({
            kind: "externalInvalidResponse",
        });
    });

    it("allows HTTP LAN endpoints without sending an empty API key", async () => {
        fetchMock.mockResolvedValue(response('{"choices":[{"message":{"content":"fix: local"}}]}'));
        const output = await requestOpenAiCompatibleCommitMessage(
            options({
                baseUrl: "http://192.168.1.5:3000/v1",
                apiKey: "",
            }),
        );
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe("http://192.168.1.5:3000/v1/chat/completions");
        expect(init?.headers).not.toHaveProperty("Authorization");
        await expect(Array.fromAsync(output)).resolves.toEqual(["fix: local"]);
    });

    it("rejects oversized JSON and SSE frames before parsing", async () => {
        fetchMock.mockResolvedValue(response("x".repeat(256_001)));
        const json = await requestOpenAiCompatibleCommitMessage(options());
        await expect(Array.fromAsync(json)).rejects.toMatchObject({
            kind: "externalInvalidResponse",
        });

        fetchMock.mockResolvedValue(streamedResponse([`data: ${"x".repeat(32_001)}\n\n`]));
        const sse = await requestOpenAiCompatibleCommitMessage(options());
        await expect(Array.fromAsync(sse)).rejects.toMatchObject({
            kind: "externalInvalidResponse",
        });
    });

    it("aborts an in-flight stream when its cancellation token is signaled", async () => {
        const listeners = new Set<() => void>();
        const cancelled = {
            isCancellationRequested: false,
            onCancellationRequested(listener: () => void) {
                listeners.add(listener);
                return { dispose: () => listeners.delete(listener) };
            },
        };
        fetchMock.mockImplementation(
            async (_url, init) =>
                new Response(
                    new ReadableStream({
                        start(controller) {
                            controller.enqueue(
                                new TextEncoder().encode(
                                    'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
                                ),
                            );
                            init?.signal?.addEventListener("abort", () =>
                                controller.error(new Error("aborted")),
                            );
                        },
                    }),
                    { headers: { "content-type": "text/event-stream" } },
                ),
        );
        const output = await requestOpenAiCompatibleCommitMessage(options({ token: cancelled }));
        const stream = output[Symbol.asyncIterator]();
        await expect(stream.next()).resolves.toEqual({ value: "partial", done: false });
        cancelled.isCancellationRequested = true;
        for (const listener of listeners) listener();
        await expect(stream.next()).rejects.toMatchObject({ kind: "cancelled" });
    });

    it("honors cancellation before starting the request", async () => {
        const cancelled = token();
        cancelled.isCancellationRequested = true;

        await expect(
            requestOpenAiCompatibleCommitMessage(options({ token: cancelled })),
        ).rejects.toMatchObject({ kind: "cancelled" });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("maps an aborted request caused by the deadline to externalTimeout", async () => {
        vi.useFakeTimers();
        fetchMock.mockImplementation(
            (_input, init) =>
                new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener("abort", () =>
                        reject(new DOMException("aborted", "AbortError")),
                    );
                }),
        );

        const pending = requestOpenAiCompatibleCommitMessage(options());
        const assertion = expect(pending).rejects.toMatchObject({ kind: "externalTimeout" });
        await vi.advanceTimersByTimeAsync(45_000);

        await assertion;
    });
});
