// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
// import fetch from "node-fetch";
import { GitExtension, API, Repository, APIState } from "./@types/git";
import * as childProcess from "child_process";
import { promisify } from "util";
import fetch from "node-fetch";

function spawn(command: string, args: string[], options: any): Promise<string> {
  console.log("spawn", command, args);
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, options);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr));
      } else {
        resolve(stdout);
      }
    });
  });
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  let disposable = vscode.commands.registerCommand(
    "commit-o-matic.generate-commit",
    async () => {
      const apiKey = vscode.workspace
        .getConfiguration("commit-o-matic")
        .get("apiKey") as string;
      const promptTemplate = vscode.workspace
        .getConfiguration("commit-o-matic")
        .get("promptTemplate") as string;
      const ignoredFiles = vscode.workspace
        .getConfiguration("commit-o-matic")
        .get("ignoredFiles") as string[];
      if (!apiKey) {
        vscode.window
          .showErrorMessage(
            "No OpenAI API token found.",
            {
              detail:
                "Please go to https://platform.openai.com/account/api-keys and create a new API key. Then set the 'commit-o-matic.apiKey' setting to the new API key.",
            },
            "Go to OpenAI",
            "Open Settings"
          )
          .then((value) => {
            if (value === "Go to OpenAI") {
              vscode.env.openExternal(
                vscode.Uri.parse("https://platform.openai.com/account/api-keys")
              );
            } else if (value === "Open Settings") {
              vscode.commands.executeCommand(
                "workbench.action.openSettings",
                "commit-o-matic.apiToken"
              );
            }
          });
        return;
      }

      let gitExtension = vscode.extensions.getExtension("vscode.git");

      if (!gitExtension) {
        vscode.window.showErrorMessage("Git extension not found");
        return;
      }
      const git = gitExtension.exports.getAPI(1) as API;
      let selected = git?.repositories.find((repo) => repo.ui.selected);

      if (!selected) {
        selected = git?.repositories[0];
      }
      if (!selected) {
        vscode.window.showErrorMessage("No Git repository found");
        return;
      }

      if (selected.rootUri.scheme !== "file") {
        vscode.window.showErrorMessage(
          "Only local repositories are supported (scheme != file)"
        );
        return;
      }

      let diffExcludes: string[] = [];
      if (Array.isArray(ignoredFiles) && ignoredFiles.length > 0) {
        diffExcludes.push("--", ".");
        diffExcludes.push(
          ...ignoredFiles.map((file) => {
            return `:(exclude)**/${file}`;
          })
        );
      }

      let areThereStagedChanges =
        (
          await spawn("git", ["diff", "--staged"], {
            cwd: selected.rootUri.path,
          })
        ).trim() !== "";

      let diff = "";
      diff = await spawn("git", ["diff", "--staged", ...diffExcludes], {
        cwd: selected.rootUri.path,
      });

      if (diff.trim() === "" && areThereStagedChanges) {
        vscode.window.showErrorMessage(
          "Staged changes consist of files ignored by Commit-o-matic only."
        );
        return;
      }

      let didUseUnstagedChanges = false;

      if (diff.trim() === "") {
        diff = await spawn("git", ["diff", ...diffExcludes], {
          cwd: selected.rootUri.path,
        });
        didUseUnstagedChanges = true;
      }

      if (diff.trim() === "") {
        vscode.window.showErrorMessage("No changes to commit");
        return;
      }

      // roughly count the words in the diff and warn if it's too big
      const wordsCount = diff.split(/\s+/).length;
      if (wordsCount > 1000) {
        const result = await vscode.window
          .showWarningMessage(
            `The diff contains ${wordsCount} words. This might incur a higher ChatGPT usage cost. Do you want to continue?`,
            { modal: true },
            "Yes",
            "No"
          )
          .then((value) => {
            return value === "Yes";
          });
        if (!result) {
          return;
        }
      }

      try {
        const resp = await fetch("https://api.openai.com/v1/chat/completions", {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          method: "POST",
          body: JSON.stringify({
            model: "gpt-3.5-turbo",
            messages: [
              {
                role: "system",
                content:
                  "You are a helpful assistant for creating git commit messages from git diffs. You can only output the commit message.",
              },
              {
                role: "user",
                content: promptTemplate.replace(/\$\$\$DIFF\$\$\$/g, diff),
              },
            ],
          }),
        });

        if (!resp.ok) {
          const error = await resp.text();
          throw new Error(error);
        }
        const json = (await resp.json()) as any;

        const { choices, usage } = json;
        if (!Array.isArray(choices) || choices.length === 0) {
          throw new Error("No choices returned");
        }
        const commitContent = choices[0].message.content;

        selected.inputBox.value = commitContent;
        const chatGptPrice = 0.002 / 1000;
        vscode.window.showInformationMessage(
          `Commit message generated\n Usage: ${usage.total_tokens} tokens - $${
            usage.total_tokens * chatGptPrice
          } `
        );
      } catch (e) {
        console.error(e);
        vscode.window.showErrorMessage(
          "Error communicating with OpenAI: " + (e as any).message
        );
      }
    }
  );

  context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
export function deactivate() {}
