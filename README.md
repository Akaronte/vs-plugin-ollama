# Ollama Copilot Lite — Tu Copilot local con Ollama

Extensión de VS Code para obtener sugerencias de código locales (ghost text), comandos rápidos y un panel de chat usando [Ollama](https://ollama.com). Todo corre en tu máquina: privacidad y cero latencia de red externa.

## Características
- Sugerencias en línea (ghost text) estilo Copilot, sin APIs propuestas.
- Comandos de prompt:
	- Prompt to Code (insertar en cursor)
	- Prompt Replace Selection (reemplazar selección)
	- Prompt Preview (ver resultado en una pestaña nueva)
- Panel de Chat (Webview): envía prompts, ve respuestas y “Insertar en editor”.
- Toggle por archivo desde la status bar (“Ollama: On/Off”).
- Configurable: URL, modelo, temperatura, tokens, contexto y timeout.

## Requisitos
- Node.js 18+
- VS Code 1.88+
- Ollama corriendo en `http://localhost:11434` y un modelo de código instalado (p. ej. `qwen2.5-coder:7b`, `deepseek-coder`, `codellama`, etc.).

## Instalación rápida (VSIX)
1. Genera el paquete (opcional si usas el `.vsix` ya incluido):
	 ```
	 npm run package
	 ```
2. Instálalo desde VS Code:
	 - Extensiones → “…” → Install from VSIX…
	 - Selecciona `ollama-copilot-lite-<version>.vsix` (en la raíz del repo)
	 - O por CLI:
		 ```cmd
		 code --install-extension "c:\\ruta\\a\\ollama-copilot-lite-<version>.vsix"
		 ```

## Uso
### Ghost text (sugerencias en línea)
1. Abre un archivo soportado (js, ts, py, go, java, csharp, rust, cpp, php).
2. Empieza a escribir; verás sugerencias fantasma.
3. Acepta con Tab/Enter (según keybindings de tu VS Code).
4. Toggle rápido por archivo: Status bar “Ollama: On/Off” o comando “Ollama Copilot: Toggle for File”.

### Comandos de prompt
- “Ollama Copilot: Prompt to Code (insert)” — inserta en el cursor. Atajo: `Ctrl+Alt+Y`.
- “Ollama Copilot: Prompt Replace Selection” — reemplaza la selección. Atajo: `Ctrl+Alt+U`.
- “Ollama Copilot: Prompt Preview” — abre el resultado en una pestaña nueva.

### Panel de Chat
- Abrir: “Ollama Copilot: Open Chat” o `Ctrl+Alt+I`.
- Escribe prompts, revisa la respuesta y usa “Insertar en editor”.

## Configuración
Busca “Ollama Copilot Lite” en Settings:
- `ollamaCopilot.enabled` (bool, scope por recurso)
- `ollamaCopilot.baseUrl` (string, default `http://localhost:11434`)
- `ollamaCopilot.model` (string, default `qwen2.5-coder:7b`)
- `ollamaCopilot.temperature` (number, default `0.2`)
- `ollamaCopilot.maxTokens` (number, default `128`)
- `ollamaCopilot.maxPrefixChars` (number, default `4000`)
- `ollamaCopilot.maxSuffixChars` (number, default `1000`)
- `ollamaCopilot.requestTimeoutMs` (number, default `20000`)

## Desarrollo (opcional)
1. Instala dependencias: `npm install`
2. Compila: `npm run compile`
3. Ejecuta en modo desarrollo: F5 (abre una Extension Development Host)

## Solución de problemas
- “No aparecen sugerencias”: verifica que Ollama esté activo y el modelo exista; revisa `baseUrl`/`model` en Settings.
- Revisa los logs en “View → Output → Ollama Copilot”.
- Aumenta `requestTimeoutMs` si el modelo tarda más.
- Ajusta `maxPrefixChars`/`maxSuffixChars` si el archivo es muy grande.

## Licencia
MIT (ver `LICENSE`).