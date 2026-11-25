import * as vscode from 'vscode'
import { MANIFESTS, type ProjectFile } from './projectcontext'

const MAX_BYTES = 200_000

/** The manifest files at the top of the workspace folder of the active file (or the first folder). Files that are missing or large are skipped. */
export async function readProjectFiles(): Promise<ProjectFile[]> {
  const active = vscode.window.activeTextEditor?.document.uri
  const folder = (active && vscode.workspace.getWorkspaceFolder?.(active)) || vscode.workspace.workspaceFolders?.[0]
  if (!folder) return []
  const files: ProjectFile[] = []
  for (const name of MANIFESTS) {
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, name))
      if (bytes.byteLength <= MAX_BYTES) files.push({ name, text: new TextDecoder().decode(bytes) })
    } catch {
      // the file does not exist in this project
    }
  }
  return files
}
