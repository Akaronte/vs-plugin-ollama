import * as vscode from 'vscode';

type OllamaGenerateResponse = {
  response?: string;
  done?: boolean;
  error?: string;
};

export function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel('Ollama Copilot');
  const provider = new OllamaInlineProvider(log);
  const selector: vscode.DocumentSelector = [
    { scheme: 'file', language: 'javascript' },
    { scheme: 'file', language: 'typescript' },
    { scheme: 'file', language: 'python' },
    { scheme: 'file', language: 'go' },
    { scheme: 'file', language: 'java' },
    { scheme: 'file', language: 'csharp' },
    { scheme: 'file', language: 'rust' },
    { scheme: 'file', language: 'cpp' },
    { scheme: 'file', language: 'php' },
  ];

  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(selector, provider)
  );

  // Status bar toggle for current file
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'ollamaCopilot.toggleEnabled';
  context.subscriptions.push(status);

  const updateStatus = () => {
    const enabled = getEnabledForActiveEditor();
    status.text = enabled ? 'Ollama: On' : 'Ollama: Off';
    status.tooltip = 'Toggle Ollama Copilot inline suggestions for this file';
    status.show();
  };

  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateStatus));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('ollamaCopilot.enabled')) updateStatus();
  }));
  updateStatus();

  // Toggle command
  const toggleCmd = vscode.commands.registerCommand('ollamaCopilot.toggleEnabled', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const uri = editor.document.uri;
    const cfg = vscode.workspace.getConfiguration('ollamaCopilot', uri);
    const current = cfg.get<boolean>('enabled', true);
    await cfg.update('enabled', !current, vscode.ConfigurationTarget.WorkspaceFolder);
    updateStatus();
  });
  context.subscriptions.push(toggleCmd);

  // Open chat webview panel
  const openChatCmd = vscode.commands.registerCommand('ollamaCopilot.openChat', async () => {
    const panel = vscode.window.createWebviewPanel(
      'ollamaCopilotChat',
      'Ollama Copilot Chat',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    const getHtml = () => {
      const nonce = Math.random().toString(36).slice(2);
      return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Ollama Copilot Chat</title>
  <style>
    body { font-family: sans-serif; margin: 0; display: flex; flex-direction: column; height: 100vh; }
    header { padding: 8px 12px; border-bottom: 1px solid #444; }
    #log { flex: 1; overflow: auto; padding: 12px; }
    .msg { margin: 8px 0; }
    .user { color: #89d185; }
    .assistant { color: #9cdcfe; white-space: pre-wrap; }
    form { display: flex; gap: 8px; padding: 12px; border-top: 1px solid #444; }
    input[type="text"] { flex: 1; padding: 8px; }
    button { padding: 8px 12px; }
    .actions { display: flex; gap: 6px; margin-top: 6px; }
  </style>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    function appendMessage(role, text) {
      const log = document.getElementById('log');
      const div = document.createElement('div');
      div.className = 'msg ' + role;
      div.textContent = (role === 'user' ? 'Tú: ' : 'Asistente: ') + text;
      log.appendChild(div);
      log.scrollTop = log.scrollHeight;
      return div;
    }
    window.addEventListener('message', (event) => {
      const { type, text } = event.data || {};
      if (type === 'assistant') {
        const resDiv = appendMessage('assistant', text || '');
        const actions = document.createElement('div');
        actions.className = 'actions';
        const insertBtn = document.createElement('button');
        insertBtn.textContent = 'Insertar en editor';
        insertBtn.onclick = () => vscode.postMessage({ type: 'insert', text });
        actions.appendChild(insertBtn);
        resDiv.appendChild(actions);
      }
    });
    function onSubmit(e) {
      e.preventDefault();
      const input = document.getElementById('prompt');
      const value = input.value.trim();
      if (!value) return;
      appendMessage('user', value);
      vscode.postMessage({ type: 'prompt', text: value });
      input.value = '';
      input.focus();
    }
  </script>
</head>
<body>
  <header>Ollama Copilot Chat</header>
  <div id="log"></div>
  <form onsubmit="onSubmit(event)">
    <input id="prompt" type="text" placeholder="Escribe tu prompt y presiona Enter..." />
    <button type="submit">Enviar</button>
  </form>
</body>
</html>`;
    };

    panel.webview.html = getHtml();

    const disposables: vscode.Disposable[] = [];
    panel.onDidDispose(() => {
      disposables.forEach(d => d.dispose());
    }, null, context.subscriptions);

    panel.webview.onDidReceiveMessage(async (msg) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      if (msg?.type === 'prompt') {
        const doc = editor.document;
        const pos = editor.selection.active;
        const cfg = vscode.workspace.getConfiguration('ollamaCopilot', doc.uri);
        const maxPrefixChars = cfg.get<number>('maxPrefixChars', 4000);
        const maxSuffixChars = cfg.get<number>('maxSuffixChars', 1000);

        const startLine = Math.max(0, pos.line - 2000);
        const startPos = new vscode.Position(startLine, 0);
        let prefix = doc.getText(new vscode.Range(startPos, pos));
        if (prefix.length > maxPrefixChars) prefix = prefix.slice(prefix.length - maxPrefixChars);

        const endLine = Math.min(doc.lineCount - 1, pos.line + 200);
        const endPos = doc.lineAt(endLine).range.end;
        let suffix = doc.getText(new vscode.Range(pos, endPos));
        if (suffix.length > maxSuffixChars) suffix = suffix.slice(0, maxSuffixChars);

        const languageId = doc.languageId;
        const prompt = [
          `Eres un asistente que escribe código en ${languageId}.`,
          'Instrucciones del usuario:',
          '"""',
          String(msg.text ?? ''),
          '"""',
          'Contexto (prefijo):',
          '"""',
          prefix,
          '"""',
          'Contexto (sufijo):',
          '"""',
          suffix,
          '"""',
          'Responde SOLO con código.'
        ].join('\n');

        const tokenSource = new vscode.CancellationTokenSource();
        try {
          const resp = await callOllama(prompt, tokenSource.token);
          const cleaned = postProcessSuggestion(resp ?? '', suffix);
          panel.webview.postMessage({ type: 'assistant', text: cleaned || resp || '' });
        } catch (err: any) {
          panel.webview.postMessage({ type: 'assistant', text: `Error: ${String(err?.message ?? err)}` });
        } finally {
          tokenSource.dispose();
        }
      } else if (msg?.type === 'insert') {
        const text = String(msg.text ?? '');
        if (!text) return;
        await editor.edit((edit) => edit.insert(editor.selection.active, text));
      }
    }, undefined, disposables);
  });
  context.subscriptions.push(openChatCmd);
  // Prompt-to-code command: ask user for a prompt, send with context, and insert response
  const promptCmd = vscode.commands.registerCommand('ollamaCopilot.promptToCode', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const question = await vscode.window.showInputBox({
      title: 'Ollama Copilot: Prompt to Code',
      placeHolder: 'Describe lo que quieres generar...'
    });
    if (!question) return;

    const doc = editor.document;
    const pos = editor.selection.active;
    const cfg = vscode.workspace.getConfiguration('ollamaCopilot', doc.uri);
    const maxPrefixChars = cfg.get<number>('maxPrefixChars', 4000);
    const maxSuffixChars = cfg.get<number>('maxSuffixChars', 1000);

    // Reuse context computation
    const startLine = Math.max(0, pos.line - 2000);
    const startPos = new vscode.Position(startLine, 0);
    let prefix = doc.getText(new vscode.Range(startPos, pos));
    if (prefix.length > maxPrefixChars) prefix = prefix.slice(prefix.length - maxPrefixChars);

    const endLine = Math.min(doc.lineCount - 1, pos.line + 200);
    const endPos = doc.lineAt(endLine).range.end;
    let suffix = doc.getText(new vscode.Range(pos, endPos));
    if (suffix.length > maxSuffixChars) suffix = suffix.slice(0, maxSuffixChars);

    const languageId = doc.languageId;
    const prompt = [
      `Eres un asistente que escribe código en ${languageId}.`,
      'Instrucciones del usuario:',
      '"""',
      question,
      '"""',
      'Contexto (prefijo):',
      '"""',
      prefix,
      '"""',
      'Contexto (sufijo):',
      '"""',
      suffix,
      '"""',
      'Responde SOLO con código a insertar en la posición actual.'
    ].join('\n');

    log.appendLine(`[${new Date().toISOString()}] Prompt command invoked (${languageId})`);
    const tokenSource = new vscode.CancellationTokenSource();
    try {
      const resp = await callOllama(prompt, tokenSource.token);
      if (!resp) return;
      const cleaned = postProcessSuggestion(resp, suffix);
      if (!cleaned) return;
      await editor.edit((edit) => edit.insert(pos, cleaned));
    } catch (err: any) {
      log.appendLine(`Prompt command error: ${String(err?.message ?? err)}`);
    } finally {
      tokenSource.dispose();
    }
  });
  context.subscriptions.push(promptCmd);

  // Prompt preview: show response in a new untitled document
  const previewCmd = vscode.commands.registerCommand('ollamaCopilot.promptPreview', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const question = await vscode.window.showInputBox({
      title: 'Ollama Copilot: Prompt Preview',
      placeHolder: 'Describe lo que quieres generar...'
    });
    if (!question) return;

    const doc = editor.document;
    const pos = editor.selection.active;
    const cfg = vscode.workspace.getConfiguration('ollamaCopilot', doc.uri);
    const maxPrefixChars = cfg.get<number>('maxPrefixChars', 4000);
    const maxSuffixChars = cfg.get<number>('maxSuffixChars', 1000);

    const startLine = Math.max(0, pos.line - 2000);
    const startPos = new vscode.Position(startLine, 0);
    let prefix = doc.getText(new vscode.Range(startPos, pos));
    if (prefix.length > maxPrefixChars) prefix = prefix.slice(prefix.length - maxPrefixChars);

    const endLine = Math.min(doc.lineCount - 1, pos.line + 200);
    const endPos = doc.lineAt(endLine).range.end;
    let suffix = doc.getText(new vscode.Range(pos, endPos));
    if (suffix.length > maxSuffixChars) suffix = suffix.slice(0, maxSuffixChars);

    const languageId = doc.languageId;
    const prompt = [
      `Eres un asistente que escribe código en ${languageId}.`,
      'Instrucciones del usuario:',
      '"""',
      question,
      '"""',
      'Contexto (prefijo):',
      '"""',
      prefix,
      '"""',
      'Contexto (sufijo):',
      '"""',
      suffix,
      '"""',
      'Responde SOLO con código.'
    ].join('\n');

    log.appendLine(`[${new Date().toISOString()}] Prompt preview invoked (${languageId})`);
    const tokenSource = new vscode.CancellationTokenSource();
    try {
      const resp = await callOllama(prompt, tokenSource.token);
      if (!resp) return;
      const cleaned = postProcessSuggestion(resp, suffix);
      const previewDoc = await vscode.workspace.openTextDocument({
        content: cleaned ?? resp,
        language: languageId,
      });
      await vscode.window.showTextDocument(previewDoc, { preview: true });
    } catch (err: any) {
      log.appendLine(`Prompt preview error: ${String(err?.message ?? err)}`);
    } finally {
      tokenSource.dispose();
    }
  });
  context.subscriptions.push(previewCmd);

  // Prompt replace selection: replace current selection with response
  const replaceCmd = vscode.commands.registerCommand('ollamaCopilot.promptReplaceSelection', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const selection = editor.selection;
    if (selection.isEmpty) return;
    const question = await vscode.window.showInputBox({
      title: 'Ollama Copilot: Prompt Replace Selection',
      placeHolder: 'Describe cómo transformar/reemplazar la selección...'
    });
    if (!question) return;

    const doc = editor.document;
    const pos = selection.start; // usar inicio de selección
    const cfg = vscode.workspace.getConfiguration('ollamaCopilot', doc.uri);
    const maxPrefixChars = cfg.get<number>('maxPrefixChars', 4000);
    const maxSuffixChars = cfg.get<number>('maxSuffixChars', 1000);

    const startLine = Math.max(0, pos.line - 2000);
    const startPos = new vscode.Position(startLine, 0);
    let prefix = doc.getText(new vscode.Range(startPos, pos));
    if (prefix.length > maxPrefixChars) prefix = prefix.slice(prefix.length - maxPrefixChars);

    const endLine = Math.min(doc.lineCount - 1, selection.end.line + 200);
    const endPos = doc.lineAt(endLine).range.end;
    let suffix = doc.getText(new vscode.Range(selection.end, endPos));
    if (suffix.length > maxSuffixChars) suffix = suffix.slice(0, maxSuffixChars);

    const languageId = doc.languageId;
    const selectedText = doc.getText(selection);
    const prompt = [
      `Eres un asistente que edita código en ${languageId}.`,
      'Transforma/reemplaza la selección según las instrucciones del usuario. Responde solo con el código final para reemplazar la selección.',
      'Instrucciones del usuario:',
      '"""',
      question,
      '"""',
      'Selección actual:',
      '"""',
      selectedText,
      '"""',
      'Contexto (prefijo):',
      '"""',
      prefix,
      '"""',
      'Contexto (sufijo):',
      '"""',
      suffix,
      '"""'
    ].join('\n');

    log.appendLine(`[${new Date().toISOString()}] Prompt replace selection invoked (${languageId})`);
    const tokenSource = new vscode.CancellationTokenSource();
    try {
      const resp = await callOllama(prompt, tokenSource.token);
      if (!resp) return;
      const cleaned = postProcessSuggestion(resp, suffix);
      await editor.edit((edit) => edit.replace(selection, cleaned ?? resp));
    } catch (err: any) {
      log.appendLine(`Prompt replace selection error: ${String(err?.message ?? err)}`);
    } finally {
      tokenSource.dispose();
    }
  });
  context.subscriptions.push(replaceCmd);
}

function getEnabledForActiveEditor(): boolean {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return true;
  const cfg = vscode.workspace.getConfiguration('ollamaCopilot', editor.document.uri);
  return cfg.get<boolean>('enabled', true);
}

export function deactivate() {}

class OllamaInlineProvider implements vscode.InlineCompletionItemProvider {
  constructor(private log: vscode.OutputChannel) {}
  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionList | vscode.InlineCompletionItem[] | undefined> {
    const cfg = vscode.workspace.getConfiguration('ollamaCopilot', document.uri);
    const enabled = cfg.get<boolean>('enabled', true);
    if (!enabled) return;

    const maxPrefixChars = cfg.get<number>('maxPrefixChars', 4000);
    const maxSuffixChars = cfg.get<number>('maxSuffixChars', 1000);

    const { prefix, suffix } = this.getContext(document, position, maxPrefixChars, maxSuffixChars);
    if (!prefix && !suffix) return;

    const languageId = document.languageId;
    const prompt = buildPrompt(prefix, suffix, languageId);

    try {
      this.log.appendLine(`[${new Date().toISOString()}] Requesting suggestion (${document.languageId})`);
      const suggestion = await callOllama(prompt, token);
      if (!suggestion) return;

      const cleaned = postProcessSuggestion(suggestion, suffix);
      if (!cleaned) return;

      const item = new vscode.InlineCompletionItem(cleaned, new vscode.Range(position, position));
      return [item];
    } catch (err: any) {
      this.log.appendLine(`Error: ${String(err?.message ?? err)}`);
      return;
    }
  }

  private getContext(
    document: vscode.TextDocument,
    position: vscode.Position,
    maxPrefixChars: number,
    maxSuffixChars: number
  ): { prefix: string; suffix: string } {
    // Prefix: up to maxPrefixChars before the position
    const startLine = Math.max(0, position.line - 2000); // safety line cap
    const startPos = new vscode.Position(startLine, 0);
    let prefix = document.getText(new vscode.Range(startPos, position));
    if (prefix.length > maxPrefixChars) {
      prefix = prefix.slice(prefix.length - maxPrefixChars);
    }

    // Suffix: up to maxSuffixChars after the position
    const endLine = Math.min(document.lineCount - 1, position.line + 200);
    const endPos = document.lineAt(endLine).range.end;
    let suffix = document.getText(new vscode.Range(position, endPos));
    if (suffix.length > maxSuffixChars) {
      suffix = suffix.slice(0, maxSuffixChars);
    }

    return { prefix, suffix };
  }
}

function buildPrompt(prefix: string, suffix: string, languageId: string): string {
  // Simple fill-in-the-middle style prompt using prefix and suffix
  return [
    `Eres un asistente que completa código en ${languageId}.`,
    'Tarea: Completa el siguiente código en el punto indicado, sin explicaciones, solo el código que continúa.',
    'Prefijo:',
    '"""',
    prefix,
    '"""',
    'Sufijo:',
    '"""',
    suffix,
    '"""',
    'Respuesta (solo el código que falta entre prefijo y sufijo):'
  ].join('\n');
}

async function callOllama(prompt: string, cancelToken: vscode.CancellationToken): Promise<string | undefined> {
  const cfg = vscode.workspace.getConfiguration('ollamaCopilot');
  const baseUrl = cfg.get<string>('baseUrl', 'http://localhost:11434')!.replace(/\/$/, '');
  const model = cfg.get<string>('model', 'qwen2.5-coder:7b')!;
  const temperature = cfg.get<number>('temperature', 0.2)!;
  const maxTokens = cfg.get<number>('maxTokens', 128)!;
  const timeoutMs = cfg.get<number>('requestTimeoutMs', 20000)!;

  const controller = new AbortController();
  const onCancel = cancelToken.onCancellationRequested(() => controller.abort());
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  try {
    const res = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: {
          temperature,
          num_predict: maxTokens,
        },
      }),
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    });

    if (!res.ok) return;

    const json = (await res.json()) as OllamaGenerateResponse;
    if (json?.response) {
      return json.response;
    }
    return;
  } finally {
    onCancel.dispose();
    clearTimeout(timer);
  }
}

function postProcessSuggestion(s: string, suffix: string): string {
  let out = s;

  // Strip common fenced code markers if the LLM adds them
  out = out.replace(/^```[a-zA-Z]*\n/, '');
  out = out.replace(/\n```\s*$/, '');

  // Avoid duplicating the first character of the suffix
  if (suffix && out.endsWith(suffix[0])) {
    out = out.slice(0, -1);
  }

  // If suggestion is only whitespace, return empty
  if (/^\s*$/.test(out)) return '';
  return out;
}
