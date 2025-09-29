<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Gemini Voz en Tiempo Real</title>
    <link rel="stylesheet" href="style.css">
</head>
<body>
    <main class="app" aria-live="polite">
        <header class="app__header">
            <h1 class="app__title">Asistente de voz con Gemini</h1>
            <p id="status" class="app__status" data-variant="info">Listo para escuchar</p>
        </header>
        <section class="mic" aria-label="Controles de conversación">
            <button id="micButton" class="mic__button" type="button" aria-pressed="false">
                <span class="visually-hidden">Iniciar o detener la conversación</span>
                <svg class="mic__icon" width="64" height="64" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
                    <defs>
                        <linearGradient id="micGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                            <stop offset="0%" stop-color="#7f5fff" />
                            <stop offset="100%" stop-color="#3fa9f5" />
                        </linearGradient>
                    </defs>
                    <circle cx="32" cy="32" r="30" fill="url(#micGradient)" />
                    <path d="M32 18a7 7 0 0 0-7 7v10a7 7 0 0 0 14 0V25a7 7 0 0 0-7-7zm12 17a12 12 0 0 1-24 0h-4a16 16 0 0 0 14 15.9V56h4v-5.1A16 16 0 0 0 48 35z" fill="#fff" />
                </svg>
                <span class="mic__pulse" aria-hidden="true"></span>
            </button>
        </section>
        <section class="transcript" id="transcript" aria-live="polite" aria-label="Historial de conversación">
            <p class="transcript__placeholder">Aquí aparecerán los mensajes de la conversación.</p>
        </section>
    </main>
    <script type="module" src="script.js"></script>
</body>
</html>
