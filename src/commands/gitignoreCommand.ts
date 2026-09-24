import * as vscode from "vscode";
import type { GitExecutor } from "../git/executor";
import { assertRepoRelativePath } from "../utils/fileOps";

/** Escapes glob characters so a clicked path is ignored literally, not as a pattern. */
function gitignoreRule(relativePath: string, isFolder: boolean): string {
    const safePath = assertRepoRelativePath(relativePath);
    const escaped = safePath
        .replace(/([*?\[\]\\])/g, "\\$1")
        .replace(/ +$/, (spaces) => spaces.replace(/ /g, "\\ "));
    return `/${escaped}${isFolder ? "/" : ""}`;
}

/** Adds a single root-relative file or whole-directory rule, then opens the repository's .gitignore. */
export async function addToGitignore(
    repositoryRoot: string,
    relativePath: string,
    isFolder: boolean,
): Promise<boolean> {
    const rule = gitignoreRule(relativePath, isFolder);
    const uri = vscode.Uri.joinPath(vscode.Uri.file(repositoryRoot), ".gitignore");
    try {
        await vscode.workspace.fs.stat(uri);
    } catch (error) {
        if ((error as { code?: string })?.code !== "FileNotFound") throw error;
        await vscode.workspace.fs.writeFile(uri, new Uint8Array());
    }

    const document = await vscode.workspace.openTextDocument(uri);
    const contents = document.getText();
    const exists = contents.split(/\r?\n/).includes(rule);
    if (!exists) {
        const lineEnding = document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
        const prefix = contents && !contents.endsWith("\n") ? lineEnding : "";
        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, document.positionAt(contents.length), `${prefix}${rule}${lineEnding}`);
        if (!(await vscode.workspace.applyEdit(edit)) || !(await document.save())) {
            throw new Error("Could not save .gitignore.");
        }
    }
    const editor = await vscode.window.showTextDocument(document);
    const end = document.positionAt(document.getText().length);
    editor.selection = new vscode.Selection(end, end);
    editor.revealRange(new vscode.Range(end, end), vscode.TextEditorRevealType.Default);
    return !exists;
}

/** Removes every indexed file at the clicked path while preserving the working-tree files. */
export async function untrackIgnoredPath(
    executor: GitExecutor,
    relativePath: string,
): Promise<boolean> {
    const safePath = assertRepoRelativePath(relativePath);
    const tracked = await executor.run([
        "--literal-pathspecs",
        "ls-files",
        "--cached",
        "-z",
        "--",
        safePath,
    ]);
    if (!tracked) return false;
    await executor.run([
        "--literal-pathspecs",
        "rm",
        "--cached",
        "-r",
        "-f",
        "--ignore-unmatch",
        "--",
        safePath,
    ]);
    return true;
}
