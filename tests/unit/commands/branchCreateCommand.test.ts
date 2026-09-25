import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Branch } from "../../../src/types";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

const mocks = vi.hoisted(() => ({
    showInputBox: vi.fn(),
    showErrorMessage: vi.fn(),
    showTimedInformationMessage: vi.fn(),
    executeCommand: vi.fn(),
}));

vi.mock("vscode", () => ({
    l10n: {
        t: (message: string, args?: Record<string, unknown>) =>
            args
                ? message.replace(/\{(\w+)\}/g, (_match, key: string) => String(args[key] ?? ""))
                : message,
    },
    window: {
        showInputBox: mocks.showInputBox,
        showErrorMessage: mocks.showErrorMessage,
    },
    commands: { executeCommand: mocks.executeCommand },
}));

vi.mock("../../../src/utils/notifications", () => ({
    runWithNotificationProgress: async (_label: string, task: () => Promise<void>) => task(),
    showTimedInformationMessage: mocks.showTimedInformationMessage,
    showTimedWarningMessage: vi.fn(),
}));

import { createBranchCommands, type BranchCommandDeps } from "../../../src/commands/branchCommands";

const execFileAsync = promisify(execFile);
const scratchRoots: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, { cwd });
    return stdout.trim();
}

afterEach(async () => {
    await Promise.all(scratchRoots.splice(0).map((root) => removeScratchDirectories(root)));
});

function makeBranch(name: string, isRemote: boolean, isCurrent = false): Branch {
    return { name, hash: "a".repeat(40), isRemote, isCurrent, ahead: 0, behind: 0 };
}

function makeCommands(branches: Branch[]) {
    const executor = { run: vi.fn(async () => "") };
    const deps = {
        executor,
        gitOps: {},
        getCurrentBranchName: () => branches.find((branch) => branch.isCurrent)?.name,
        getCurrentBranches: () => branches,
        createWorktree: vi.fn(),
        openConflictSession: vi.fn(),
        refreshConflictUi: vi.fn(),
    } as unknown as BranchCommandDeps;
    const commands = createBranchCommands(deps);
    const handler = (id: string) => {
        const entry = commands.find((candidate) => candidate.id === id);
        if (!entry) throw new Error(`Missing branch command: ${id}`);
        return entry.handler;
    };
    return { executor, deps, handler };
}

describe("intelligit.newBranchFrom", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.showInputBox.mockResolvedValue("feature/new");
    });

    it("creates a local branch from a remote without tracking its source or creating a worktree", async () => {
        const source = makeBranch("origin/main", true);
        const { executor, deps, handler } = makeCommands([source]);

        await handler("intelligit.newBranchFrom")({ branch: source });

        expect(executor.run).toHaveBeenCalledWith([
            "checkout",
            "--no-track",
            "-b",
            "feature/new",
            "origin/main",
        ]);
        expect(deps.createWorktree).not.toHaveBeenCalled();
        expect(mocks.executeCommand).toHaveBeenCalledWith("intelligit.refresh");
    });

    it("publishes to a new remote branch after creating from a remote with Git auto-tracking enabled", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "intelligit-branch-create-"));
        scratchRoots.push(root);
        const origin = path.join(root, "origin.git");
        const seed = path.join(root, "seed");
        const client = path.join(root, "client");
        await git(root, ["init", "--bare", origin]);
        await git(root, ["init", seed]);
        await git(seed, [
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "--allow-empty",
            "-m",
            "initial",
        ]);
        await git(seed, ["remote", "add", "origin", origin]);
        await git(seed, ["push", "origin", "HEAD:main"]);
        await git(root, ["clone", "-b", "main", origin, client]);
        await git(client, ["config", "branch.autoSetupMerge", "always"]);

        const source = makeBranch("origin/main", true);
        const { executor, handler } = makeCommands([source]);
        executor.run.mockImplementation((args) => git(client, args));
        await handler("intelligit.newBranchFrom")({ branch: source });

        await expect(git(client, ["rev-parse", "--abbrev-ref", "@{upstream}"])).rejects.toThrow();
        expect(
            (await git(client, ["worktree", "list", "--porcelain"])).match(/^worktree /gm),
        ).toHaveLength(1);

        await git(client, ["push", "-u", "origin", "feature/new"]);

        expect(await git(client, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
            "origin/feature/new",
        );
        expect(await git(origin, ["show-ref", "--verify", "refs/heads/feature/new"])).toContain(
            "refs/heads/feature/new",
        );
        expect(await git(origin, ["show-ref", "--verify", "refs/heads/main"])).toContain(
            "refs/heads/main",
        );
    });

    it("leaves local branch creation unchanged", async () => {
        const source = makeBranch("main", false, true);
        const { executor, handler } = makeCommands([source]);

        await handler("intelligit.newBranchFrom")({ branch: source });

        expect(executor.run).toHaveBeenCalledWith(["checkout", "-b", "feature/new", "main"]);
    });

    it("publishes an untracked current branch even if a same-named remote ref exists", async () => {
        const created = makeBranch("feature/new", false, true);
        const { executor, handler } = makeCommands([
            created,
            makeBranch("origin/main", true),
            makeBranch("origin/feature/new", true),
        ]);

        await handler("intelligit.pushBranch")({ branch: created });

        expect(mocks.executeCommand).toHaveBeenCalledWith("intelligit.publishBranch");
        expect(executor.run).not.toHaveBeenCalled();
    });

    it("keeps pushing an already tracked branch to its configured upstream", async () => {
        const created = { ...makeBranch("feature/new", false, true), upstream: "origin/main" };
        const { executor, handler } = makeCommands([created, makeBranch("origin/main", true)]);

        await handler("intelligit.pushBranch")({ branch: created });

        expect(executor.run).toHaveBeenCalledWith(["push", "origin", "feature/new:main"]);
        expect(mocks.executeCommand).not.toHaveBeenCalledWith("intelligit.publishBranch");
    });

    it("does not create a branch if the prompt is cancelled or the name is invalid", async () => {
        const source = makeBranch("origin/main", true);
        const { executor, handler } = makeCommands([source]);
        mocks.showInputBox.mockResolvedValueOnce(undefined).mockResolvedValueOnce("-invalid");

        await handler("intelligit.newBranchFrom")({ branch: source });
        await handler("intelligit.newBranchFrom")({ branch: source });

        expect(executor.run).not.toHaveBeenCalled();
        expect(mocks.showErrorMessage).toHaveBeenCalledTimes(1);
    });
});
