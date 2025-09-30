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

  let lastHealth: { ok: boolean; checking: boolean; lastCheck?: number; version?: string; error?: string } = { ok: false, checking: false };

  const renderStatus = () => {
    const enabled = getEnabledForActiveEditor();
    let healthIcon = '$(question)';
    let healthText = '';
    if (lastHealth.checking) {
      healthIcon = '$(sync~spin)';
      healthText = 'checking';
    } else if (lastHealth.ok) {
      healthIcon = '$(pass-filled)';
      healthText = lastHealth.version ? lastHealth.version : 'ok';
    } else if (lastHealth.error) {
      healthIcon = '$(warning)';
      healthText = 'err';
    }
    status.text = `${enabled ? 'Ollama: On' : 'Ollama: Off'} ${healthIcon}`;
    status.tooltip = `Toggle Ollama Copilot inline suggestions\nEndpoint: ${lastHealth.ok ? 'OK' : (lastHealth.error ? 'ERROR' : 'Unknown')} ${lastHealth.version ? '(' + lastHealth.version + ')' : ''}${lastHealth.error ? '\n' + lastHealth.error : ''}`;
    status.show();
  };

  const updateStatus = () => renderStatus();

  const checkHealth = async () => {
    if (lastHealth.checking) return;
    lastHealth.checking = true;
    renderStatus();
    const cfg = vscode.workspace.getConfiguration('ollamaCopilot');
    const baseUrl = cfg.get<string>('baseUrl', 'http://localhost:11434')!.replace(/\/$/, '');
    try {
      const v = await fetchOllamaVersion(baseUrl);
      lastHealth = { ok: true, checking: false, lastCheck: Date.now(), version: v.version };
    } catch (e: any) {
      lastHealth = { ok: false, checking: false, lastCheck: Date.now(), error: String(e?.message ?? e) };
    } finally {
      renderStatus();
    }
  };

  // Initial delayed health check & periodic refresh every 60s
  setTimeout(checkHealth, 800);
  const interval = setInterval(checkHealth, 60000);
  context.subscriptions.push({ dispose: () => clearInterval(interval) });

  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateStatus));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('ollamaCopilot.enabled')) updateStatus();
    if (e.affectsConfiguration('ollamaCopilot.baseUrl')) {
      // Re-check quickly if base URL changed
      checkHealth();
    }
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

    const rootCfg = vscode.workspace.getConfiguration('ollamaCopilot');
    const logPrompts = rootCfg.get<boolean>('logPrompts', true);
    const displaySnippet = (txt: string) => txt.length > 300 ? txt.slice(0, 300) + '…' : txt;
    if (logPrompts) {
      log.show(true);
      log.appendLine(`[${new Date().toISOString()}] Prompt command invoked (${languageId}) rawSnippet="${displaySnippet(question)}"`);
    } else {
      log.appendLine(`[${new Date().toISOString()}] Prompt command invoked (${languageId})`);
    }
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

    const rootCfgPrev = vscode.workspace.getConfiguration('ollamaCopilot');
    const logPromptsPrev = rootCfgPrev.get<boolean>('logPrompts', true);
    const displaySnippetPrev = (txt: string) => txt.length > 300 ? txt.slice(0, 300) + '…' : txt;
    if (logPromptsPrev) {
      log.show(true);
      log.appendLine(`[${new Date().toISOString()}] Prompt preview invoked (${languageId}) rawSnippet="${displaySnippetPrev(question)}"`);
    } else {
      log.appendLine(`[${new Date().toISOString()}] Prompt preview invoked (${languageId})`);
    }
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

    const rootCfgRep = vscode.workspace.getConfiguration('ollamaCopilot');
    const logPromptsRep = rootCfgRep.get<boolean>('logPrompts', true);
    const displaySnippetRep = (txt: string) => txt.length > 300 ? txt.slice(0, 300) + '…' : txt;
    if (logPromptsRep) {
      log.show(true);
      log.appendLine(`[${new Date().toISOString()}] Prompt replace selection invoked (${languageId}) rawSnippet="${displaySnippetRep(question)}"`);
    } else {
      log.appendLine(`[${new Date().toISOString()}] Prompt replace selection invoked (${languageId})`);
    }
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

  // Select model: list available Ollama models and set the choice in settings
  const selectModelCmd = vscode.commands.registerCommand('ollamaCopilot.selectModel', async () => {
    const cfg = vscode.workspace.getConfiguration('ollamaCopilot');
    const baseUrl = cfg.get<string>('baseUrl', 'http://localhost:11434')!.replace(/\/$/, '');
    try {
      const models = await fetchOllamaModels(baseUrl);
      const items: vscode.QuickPickItem[] = models.map(m => ({ label: m.name, description: m.details?.family ? `${m.details.family} ${m.details.parameter_size ?? ''}`.trim() : undefined }));
      items.push({ label: '$(edit) Escribir nombre de modelo...', description: 'Introduce un nombre manualmente' });

      const pick = await vscode.window.showQuickPick(items, { title: 'Selecciona modelo de Ollama', placeHolder: 'Elige un modelo disponible' });
      if (!pick) return;

      let chosen = pick.label;
      if (pick.label.includes('$(edit)')) {
        const manual = await vscode.window.showInputBox({ title: 'Nombre de modelo Ollama', placeHolder: 'p. ej. qwen2.5-coder:7b', value: cfg.get<string>('model', 'qwen2.5-coder:7b') });
        if (!manual) return;
        chosen = manual.trim();
      }

      await cfg.update('model', chosen, vscode.ConfigurationTarget.Workspace);
      vscode.window.showInformationMessage(`Modelo de Ollama establecido: ${chosen}`);
    } catch (err: any) {
      vscode.window.showErrorMessage(`No se pudieron listar modelos de Ollama: ${String(err?.message ?? err)}`);
    }
  });
  context.subscriptions.push(selectModelCmd);

  // Check Ollama health: query /api/version and /api/tags
  const checkHealthCmd = vscode.commands.registerCommand('ollamaCopilot.checkHealth', async () => {
    const cfg = vscode.workspace.getConfiguration('ollamaCopilot');
    const baseUrl = cfg.get<string>('baseUrl', 'http://localhost:11434')!.replace(/\/$/, '');
    try {
      const info = await fetchOllamaVersion(baseUrl);
      let modelsInfo = '';
      try {
        const models = await fetchOllamaModels(baseUrl);
        modelsInfo = `${models.length} modelos disponibles`;
      } catch (e) {
        modelsInfo = `sin listar modelos (${String((e as any)?.message ?? e)})`;
      }
      vscode.window.showInformationMessage(`Ollama OK @ ${baseUrl} - version: ${info.version || 'desconocida'} - ${modelsInfo}`);
    } catch (err: any) {
      vscode.window.showErrorMessage(`Ollama no responde @ ${baseUrl}: ${String(err?.message ?? err)}`);
    }
  });
  context.subscriptions.push(checkHealthCmd);

  // Ping model: force-load configured model with a tiny generate
  const pingModelCmd = vscode.commands.registerCommand('ollamaCopilot.pingModel', async () => {
    const cfg = vscode.workspace.getConfiguration('ollamaCopilot');
    const baseUrl = cfg.get<string>('baseUrl', 'http://localhost:11434')!.replace(/\/$/, '');
    const model = cfg.get<string>('model', 'qwen2.5-coder:7b')!;
    const prompt = [
      'Responde exactamente con la palabra "pong" y nada más.',
      'Si no puedes, responde con un mensaje de error breve.'
    ].join('\n');

    const tokenSource = new vscode.CancellationTokenSource();
    const displaySnippet = (txt: string) => {
      const trimmed = (txt ?? '').trim();
      return trimmed.length > 120 ? trimmed.slice(0, 120) + '…' : trimmed || '(respuesta vacía)';
    };

    try {
      log.show(true);
      log.appendLine(`[${new Date().toISOString()}] Ping model start -> ${model} @ ${baseUrl}`);
      const started = Date.now();
      const response = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Ollama Copilot: Cargando modelo ${model}`,
          cancellable: false,
        },
        async () => {
          return await callOllama(prompt, tokenSource.token);
        }
      );
      const elapsed = Date.now() - started;
      log.appendLine(`[${new Date().toISOString()}] Ping model done (${elapsed}ms) -> ${displaySnippet(response ?? '')}`);
      vscode.window.showInformationMessage(`Modelo ${model} respondió en ${elapsed} ms: ${displaySnippet(response ?? '')}`);
    } catch (err: any) {
      const message = `Ping al modelo ${model} falló: ${String(err?.message ?? err)}`;
      log.appendLine(`[${new Date().toISOString()}] ${message}`);
      vscode.window.showErrorMessage(message);
    } finally {
      tokenSource.dispose();
    }
  });
  context.subscriptions.push(pingModelCmd);
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
    if (typeof fetch !== 'function') {
      throw new Error('fetch no está disponible en este entorno. Asegúrate de usar VS Code 1.88+ o Node 18+.');
    }
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

    if (!res.ok) {
      let bodyText = '';
      try { bodyText = await res.text(); } catch {}
      throw new Error(`HTTP ${res.status} ${res.statusText} desde Ollama. ${bodyText?.slice(0, 500)}`);
    }

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

type OllamaTag = {
  name: string;
  model?: string;
  modified_at?: string;
  size?: number;
  digest?: string;
  details?: { family?: string; parameter_size?: string; quantization_level?: string };
};

async function fetchOllamaModels(baseUrl: string): Promise<OllamaTag[]> {
  if (typeof fetch !== 'function') {
    throw new Error('fetch no está disponible en este entorno. Usa VS Code 1.88+ o Node 18+.');
  }
  const url = `${baseUrl.replace(/\/$/, '')}/api/tags`;
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch {}
    throw new Error(`HTTP ${res.status} ${res.statusText}. ${body?.slice(0, 500)}`);
  }
  const data = (await res.json()) as { models?: OllamaTag[] };
  const models = data?.models ?? [];
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error('No se encontraron modelos. Ejecuta "ollama pull <modelo>" en tu terminal.');
  }
  return models;
}

async function fetchOllamaVersion(baseUrl: string): Promise<{ version?: string }> {
  if (typeof fetch !== 'function') {
    throw new Error('fetch no está disponible en este entorno. Usa VS Code 1.88+ o Node 18+.');
  }
  const url = `${baseUrl.replace(/\/$/, '')}/api/version`;
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch {}
    throw new Error(`HTTP ${res.status} ${res.statusText}. ${body?.slice(0, 500)}`);
  }
  const data = (await res.json()) as { version?: string };
  return data ?? {};
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
