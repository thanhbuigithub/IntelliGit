import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    getSession: vi.fn(),
    openExternal: vi.fn(),
}));

vi.mock("vscode", () => ({
    l10n: { t: (message: string) => message },
    window: {
        showErrorMessage: mocks.showErrorMessage,
        showInformationMessage: mocks.showInformationMessage,
    },
    authentication: { getSession: mocks.getSession },
    env: { openExternal: mocks.openExternal },
}));

import { showCommitMessageGenerationNotification } from "../../../src/ai/commitMessageGenerationNotifications";

beforeEach(() => {
    vi.clearAllMocks();
    mocks.showErrorMessage.mockResolvedValue(undefined);
});

describe("commit-message provider notifications", () => {
    it.each([
        [
            "copilotModelUnavailable",
            "The selected GitHub Copilot model is unavailable. Choose another model in IntelliGit settings.",
        ],
        [
            "externalConfiguration",
            "Configure the OpenAI-compatible commit-message provider in IntelliGit settings.",
        ],
        [
            "externalAuthentication",
            "OpenAI-compatible API authentication failed. Check your API key.",
        ],
        ["externalRequestFailed", "The OpenAI-compatible API request failed."],
        ["externalTimeout", "The OpenAI-compatible API request timed out."],
        ["externalInvalidResponse", "The OpenAI-compatible API returned an invalid response."],
    ] as const)("reports %s without Copilot remediation actions", async (kind, message) => {
        await showCommitMessageGenerationNotification(kind);
        expect(mocks.showErrorMessage).toHaveBeenCalledExactlyOnceWith(message);
        expect(mocks.getSession).not.toHaveBeenCalled();
        expect(mocks.openExternal).not.toHaveBeenCalled();
    });
});
