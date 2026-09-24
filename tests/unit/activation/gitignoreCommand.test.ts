import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
    const documents = new Map<
        string,
        { text: string; eol: number; save: ReturnType<typeof vi.fn> }
    >();
    const files = new Set<string>();
    return {
        documents,
        files,
        stat: vi.fn(),
        writeFile: vi.fn(),
        openTextDocument: vi.fn(),
        applyEdit: vi.fn(),
        showTextDocument: vi.fn(),
        revealRange: vi.fn(),
        editor: { selection: undefined as unknown },
    };
});

vi.mock("vscode", () => {
    class WorkspaceEdit {
        inserts: { uri: { fsPath: string }; offset: number; text: string }[] = [];
        insert(uri: { fsPath: string }, position: number, text: string): void {
            this.inserts.push({ uri, offset: position, text });
        }
    }
    return {
        Uri: {
            file: (fsPath: string) => ({ fsPath }),
            joinPath: (base: { fsPath: string }, name: string) => ({
                fsPath: `${base.fsPath}/${name}`,
            }),
        },
        EndOfLine: { LF: 1, CRLF: 2 },
        TextEditorRevealType: { Default: 0 },
        Selection: class Selection {
            constructor(public anchor: number, public active: number) {}
        },
        Range: class Range {
            constructor(public start: number, public end: number) {}
        },
        WorkspaceEdit,
        workspace: {
            fs: { stat: mocks.stat, writeFile: mocks.writeFile },
            openTextDocument: mocks.openTextDocument,
            applyEdit: mocks.applyEdit,
        },
        window: { showTextDocument: mocks.showTextDocument },
    };
});

import { addToGitignore, untrackIgnoredPath } from "../../../src/commands/gitignoreCommand";
import { GitExecutor } from "../../../src/git/executor";
import { removeScratchDirectories } from "../../helpers/scratchDirectories";

const ignoreUri = "/repo/.gitignore";

function seed(text: string, eol = 1, uri = ignoreUri): void {
    mocks.files.add(uri);
    mocks.documents.set(uri, { text, eol, save: vi.fn(async () => true) });
}

function content(uri = ignoreUri): string {
    return mocks.documents.get(uri)?.text ?? "";
}

describe("addToGitignore", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.editor.selection = undefined;
        mocks.showTextDocument.mockResolvedValue({
            ...mocks.editor,
            revealRange: mocks.revealRange,
            set selection(value: unknown) {
                mocks.editor.selection = value;
            },
        });
        mocks.files.clear();
        mocks.documents.clear();
        mocks.stat.mockImplementation(async (uri: { fsPath: string }) => {
            if (!mocks.files.has(uri.fsPath)) throw { code: "FileNotFound" };
        });
        mocks.writeFile.mockImplementation(async (uri: { fsPath: string }) => {
            seed("", 1, uri.fsPath);
        });
        mocks.openTextDocument.mockImplementation(async (uri: { fsPath: string }) => {
            const doc = mocks.documents.get(uri.fsPath)!;
            return {
                uri,
                getText: () => doc.text,
                get eol() {
                    return doc.eol;
                },
                positionAt: (offset: number) => offset,
                save: doc.save,
            };
        });
        mocks.applyEdit.mockImplementation(
            async (edit: {
                inserts: { uri: { fsPath: string }; offset: number; text: string }[];
            }) => {
                for (const { uri, offset, text } of edit.inserts) {
                    const doc = mocks.documents.get(uri.fsPath)!;
                    doc.text = doc.text.slice(0, offset) + text + doc.text.slice(offset);
                }
                return true;
            },
        );
    });

    it("creates a root .gitignore and adds exactly the selected file", async () => {
        expect(await addToGitignore("/repo", "src/app.ts", false)).toBe(true);
        expect(mocks.writeFile).toHaveBeenCalledWith({ fsPath: ignoreUri }, new Uint8Array());
        expect(content()).toBe("/src/app.ts\n");
        expect(mocks.showTextDocument).toHaveBeenCalledWith(
            expect.objectContaining({ uri: { fsPath: ignoreUri } }),
        );
        expect(mocks.editor.selection).toEqual({ anchor: content().length, active: content().length });
        expect(mocks.revealRange).toHaveBeenCalledWith(
            { start: content().length, end: content().length },
            0,
        );
    });

    it("ignores a whole folder with one rule, not only the currently changed files", async () => {
        seed("# existing\r\n", 2);
        expect(await addToGitignore("/repo", "src/cache", true)).toBe(true);
        expect(content()).toBe("# existing\r\n/src/cache/\r\n");
        expect(mocks.writeFile).not.toHaveBeenCalled();
    });

    it("preserves an existing buffer without a final newline and does not append duplicates", async () => {
        seed("# existing");
        expect(await addToGitignore("/repo", "dist/bundle.js", false)).toBe(true);
        expect(content()).toBe("# existing\n/dist/bundle.js\n");
        expect(await addToGitignore("/repo", "dist/bundle.js", false)).toBe(false);
        expect(content()).toBe("# existing\n/dist/bundle.js\n");
        expect(mocks.applyEdit).toHaveBeenCalledTimes(1);
        expect(mocks.showTextDocument).toHaveBeenCalledTimes(2);
        expect(mocks.revealRange).toHaveBeenCalledTimes(2);
        expect(mocks.editor.selection).toEqual({ anchor: content().length, active: content().length });
    });

    it("escapes gitignore glob syntax and trailing spaces in a literal path", async () => {
        seed("");
        await addToGitignore("/repo", "build/[draft]*?.txt ", false);
        expect(content()).toBe("/build/\\[draft\\]\\*\\?.txt\\ \n");
    });

    it("uses the selected repository rather than the active repository", async () => {
        seed("", 1, "/selected/.gitignore");
        await addToGitignore("/selected", "nested/new.ts", false);
        expect(content("/selected/.gitignore")).toBe("/nested/new.ts\n");
        expect(mocks.documents.has(ignoreUri)).toBe(false);
    });

    it.each(["../outside.txt", "/absolute.txt", "", "folder\nnew.txt"])(
        "rejects unsafe path %j without filesystem access",
        async (relativePath) => {
            await expect(addToGitignore("/repo", relativePath, false)).rejects.toThrow();
            expect(mocks.stat).not.toHaveBeenCalled();
        },
    );

    it("does not overwrite .gitignore when stat fails for a different reason", async () => {
        mocks.stat.mockRejectedValueOnce({ code: "NoPermissions" });
        await expect(addToGitignore("/repo", "new.ts", false)).rejects.toEqual({
            code: "NoPermissions",
        });
        expect(mocks.writeFile).not.toHaveBeenCalled();
    });

    it("does not open an editor or claim success when applying the edit fails", async () => {
        seed("");
        mocks.applyEdit.mockResolvedValueOnce(false);
        await expect(addToGitignore("/repo", "new.ts", false)).rejects.toThrow(
            "Could not save .gitignore.",
        );
        expect(mocks.showTextDocument).not.toHaveBeenCalled();
    });

    it("does not claim success when saving the document fails", async () => {
        seed("");
        mocks.documents.get(ignoreUri)!.save.mockResolvedValueOnce(false);
        await expect(addToGitignore("/repo", "new.ts", false)).rejects.toThrow(
            "Could not save .gitignore.",
        );
        expect(mocks.showTextDocument).not.toHaveBeenCalled();
    });
});

describe("untrackIgnoredPath", () => {
    const run = vi.fn(async (_args: string[]): Promise<string> => "");
    const executor = { run } as unknown as GitExecutor;

    beforeEach(() => run.mockReset());

    it("removes exactly one indexed file without deleting its working-tree copy", async () => {
        run.mockResolvedValueOnce("src/app.ts\0").mockResolvedValueOnce("");

        expect(await untrackIgnoredPath(executor, "src/app.ts")).toBe(true);
        expect(run).toHaveBeenNthCalledWith(1, [
            "--literal-pathspecs", "ls-files", "--cached", "-z", "--", "src/app.ts",
        ]);
        expect(run).toHaveBeenNthCalledWith(2, [
            "--literal-pathspecs", "rm", "--cached", "-r", "-f", "--ignore-unmatch",
            "--", "src/app.ts",
        ]);
    });

    it("removes every indexed descendant of a folder, including unchanged files", async () => {
        run.mockResolvedValueOnce("src/cache/changed.ts\0src/cache/unchanged.ts\0");
        expect(await untrackIgnoredPath(executor, "src/cache")).toBe(true);
        expect(run).toHaveBeenLastCalledWith([
            "--literal-pathspecs", "rm", "--cached", "-r", "-f", "--ignore-unmatch",
            "--", "src/cache",
        ]);
    });

    it("does not mutate the index when no matching files are tracked", async () => {
        run.mockResolvedValueOnce("");
        expect(await untrackIgnoredPath(executor, "untracked.txt")).toBe(false);
        expect(run).toHaveBeenCalledTimes(1);
    });

    it("treats glob metacharacters literally and rejects unsafe paths before Git", async () => {
        run.mockResolvedValueOnce("build/[draft]*.txt\0");
        await untrackIgnoredPath(executor, "build/[draft]*.txt");
        expect(run).toHaveBeenLastCalledWith(expect.arrayContaining(["--literal-pathspecs", "build/[draft]*.txt"]));
        run.mockClear();
        await expect(untrackIgnoredPath(executor, "../outside.txt")).rejects.toThrow();
        expect(run).not.toHaveBeenCalled();
    });

    it("propagates Git errors instead of claiming untracking succeeded", async () => {
        run.mockResolvedValueOnce("src/app.ts\0").mockRejectedValueOnce(new Error("index locked"));
        await expect(untrackIgnoredPath(executor, "src/app.ts")).rejects.toThrow("index locked");
    });

    it("keeps physical files and untracks every indexed folder descendant in a real repository", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "intelligit-gitignore-"));
        try {
            const git = new GitExecutor(root);
            await git.run(["init"]);
            await mkdir(path.join(root, "cache"));
            await mkdir(path.join(root, "cache-extra"));
            await writeFile(path.join(root, "cache", "changed.txt"), "staged");
            await writeFile(path.join(root, "cache", "unchanged.txt"), "untouched");
            await writeFile(path.join(root, "cache-extra", "keep.txt"), "sibling");
            await git.run(["add", "--", "cache", "cache-extra"]);
            await writeFile(path.join(root, "cache", "changed.txt"), "working-tree edit");

            expect(await untrackIgnoredPath(git, "cache")).toBe(true);
            expect(await git.run(["ls-files", "--", "cache"])).toBe("");
            expect(await git.run(["ls-files", "--", "cache-extra"])).toBe("cache-extra/keep.txt\n");
            expect(await readFile(path.join(root, "cache", "changed.txt"), "utf8")).toBe(
                "working-tree edit",
            );
            expect(await readFile(path.join(root, "cache", "unchanged.txt"), "utf8")).toBe(
                "untouched",
            );
            expect(await untrackIgnoredPath(git, "cache-extra/keep.txt")).toBe(true);
            expect(await git.run(["ls-files", "--", "cache-extra"])).toBe("");
            expect(await readFile(path.join(root, "cache-extra", "keep.txt"), "utf8")).toBe(
                "sibling",
            );
        } finally {
            await removeScratchDirectories(root);
        }
    });
});
