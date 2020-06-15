import * as vscode from 'vscode'

const LINE_INF = 9999

interface ResultContent {
    isIcon: boolean,
    content: string,
    hoverContent: string | vscode.MarkdownString,
    isError: boolean
}

export class Result {
    document: vscode.TextDocument
    text: string
    range: vscode.Range
    content: ResultContent
    decoration: vscode.TextEditorDecorationType
    destroyed: boolean

    constructor(editor: vscode.TextEditor, range: vscode.Range, content: ResultContent) {
        this.range = range
        this.document = editor.document
        this.text = editor.document.getText(this.range)
        this.destroyed = false

        this.setContent(content)
    }

    setContent(content: ResultContent) {
        if (this.destroyed) {
            return
        }

        this.content = content

        if (this.decoration) {
            this.remove()
        }

        const decoration = this.createDecoration()

        if (content.isIcon) {
            decoration.before.contentIconPath = content.content
        } else {
            decoration.before.contentText = content.content
        }

        this.decoration = vscode.window.createTextEditorDecorationType(decoration)

        for (const ed of vscode.window.visibleTextEditors) {
            if (ed.document === this.document) {
                ed.setDecorations(this.decoration, [{
                    hoverMessage: this.content.hoverContent,
                    range: this.decorationRange
                }])
            }
        }
    }

    createDecoration(): vscode.DecorationRenderOptions {
        if (this.content.isError) {
            return this.createErrorDecoration()
        } else {
            return this.createResultDecoration()
        }
    }

    createResultDecoration(): vscode.DecorationRenderOptions {
        return {
            before: {
                contentIconPath: undefined,
                contentText: undefined,
                backgroundColor: new vscode.ThemeColor('editorWidget.background'),
                margin: '0 0 0 10px',
                color: new vscode.ThemeColor('editor.foreground'),
            },
            rangeBehavior: vscode.DecorationRangeBehavior.OpenClosed,
        }
    }

    createErrorDecoration(): vscode.DecorationRenderOptions {
        return {
            after: {
                contentIconPath: undefined,
                contentText: undefined,
            },
            before: {
                contentIconPath: undefined,
                contentText: undefined,
            },
            // there doesn't seem to be a color that looks nicely on any color themes ...
            backgroundColor: new vscode.ThemeColor('inputValidation.errorBackground'),
            borderColor: new vscode.ThemeColor('inputValidation.errorBorder'),
            isWholeLine: true,
            rangeBehavior: vscode.DecorationRangeBehavior.OpenClosed,
        }
    }

    get decorationRange(): vscode.Range {
        return this.content.isError ? this.range :
            new vscode.Range(this.range.end.translate(0, LINE_INF), this.range.end.translate(0, LINE_INF))
    }

    draw() {
        this.setContent(this.content)
    }

    validate(e: vscode.TextDocumentChangeEvent) {
        if (this.document !== e.document) {
            return true
        }

        for (const change of e.contentChanges) {
            const intersect = change.range.intersection(this.range)
            if (intersect !== undefined && !(intersect.isEmpty && change.text === '\n')) {
                this.remove()
                return false
            }

            if (change.range.end.line < this.range.start.line ||
                (change.range.end.line === this.range.start.line &&
                    change.range.end.character <= this.range.start.character)) {
                const lines = change.text.split('\n')

                const lineOffset = lines.length - 1 - (change.range.end.line - change.range.start.line)
                const charOffset = change.range.end.line === this.range.start.line ?
                    lines[lines.length - 1].length : 0

                this.range = new vscode.Range(
                    this.range.start.translate(lineOffset, charOffset),
                    this.range.end.translate(lineOffset, charOffset)
                )
            }
        }

        if (this.document.getText(this.range) !== this.text) {
            this.remove()
            return false
        }

        return true
    }

    remove(destroy: boolean = false) {
        this.destroyed = destroy
        this.decoration.dispose()
    }
}

const results: Result[] = []

export function activate(context) {
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => validateResults(e)))
    context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors((editors) => refreshResults(editors)))

    context.subscriptions.push(vscode.commands.registerCommand('language-julia.clearAllInlineResults', removeAll))
    context.subscriptions.push(vscode.commands.registerCommand('language-julia.clearAllInlineResultsInEditor', () => removeAll(vscode.window.activeTextEditor)))
    context.subscriptions.push(vscode.commands.registerCommand('language-julia.clearCurrentInlineResult', () => removeCurrent(vscode.window.activeTextEditor)))
}

export function deactivate() { }

export function addResult(editor: vscode.TextEditor, range: vscode.Range, content: ResultContent) {
    for (let i = results.length - 1; i > -1; i--) {
        const result = results[i]
        if (result.document === editor.document && result.range.intersection(range) !== undefined) {
            removeResult(result)
        }
    }

    const result = new Result(editor, range, content)
    results.push(result)

    return result
}

interface _Frame {
    path: string,
    line: number
}
interface Frame extends _Frame {
    err: string | vscode.MarkdownString,
}

let stackFrame: Result[] = []
export function setStackTrace(err: string, stackframe: Array<_Frame>) {
    stackFrame.forEach(r => {
        r.remove()
    })

    stackFrame = []

    drawStackFrame(stackframe.map(frame => {
        return {
            path: frame.path,
            line: frame.line,
            err
        }
    }))
}

function drawStackFrame(stackFrame: Frame[], editors: vscode.TextEditor[] = vscode.window.visibleTextEditors) {
    editors.forEach(editor => {
        const path = editor.document.fileName
        stackFrame.forEach(frame => {
            if (frame.path === path) {
                addError(editor, frame)
            }
        })
    })
}

function addError(editor: vscode.TextEditor, frame: Frame) {
    const resultContent = {
        content: '',
        isIcon: false,
        hoverContent: frame.err,
        isError: true
    }
    const range = new vscode.Range(new vscode.Position(frame.line - 1, 0), new vscode.Position(frame.line - 1, LINE_INF))

    const result = new Result(editor, range, resultContent)
    stackFrame.push(result)

    return result
}

export function refreshResults(editors: vscode.TextEditor[]) {
    results.forEach(result => {
        editors.forEach(editor => {
            if (result.document === editor.document) {
                result.draw()
            }
        })
    })
    stackFrame.forEach(result => {
        editors.forEach(editor => {
            if (result.document === editor.document) {
                result.draw()
            }
        })
    })
}

export function validateResults(e: vscode.TextDocumentChangeEvent) {
    for (let i = results.length - 1; i > -1; i--) {
        const result = results[i]
        const isvalid = result.validate(e)
        if (!isvalid) {
            removeResult(result)
        }
    }
}

export function removeResult(result: Result) {
    const index = results.indexOf(result)

    if (index > -1) {
        result.remove(true)
        results.splice(index, 1)
    }
}

export function removeAll(editor: vscode.TextEditor | null = null) {
    for (let i = results.length - 1; i > -1; i--) {
        const result = results[i]
        if (editor === null || result.document === editor.document) {
            removeResult(result)
        }
    }
}

export function removeCurrent(editor: vscode.TextEditor) {
    for (const selection of editor.selections) {
        for (let i = results.length - 1; i > -1; i--) {
            const result = results[i]
            const intersect = selection.intersection(result.range)
            if (result.document === editor.document && intersect !== undefined) {
                result.remove()
            }
        }
    }
}
