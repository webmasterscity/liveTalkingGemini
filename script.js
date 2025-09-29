const dom = {
    micButton: document.getElementById('micButton'),
    status: document.getElementById('status'),
    transcript: document.getElementById('transcript'),
};

const config = {
    captureRate: 16000,
    playbackFallbackRate: 24000,
    wsEndpoint: 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent',
    apiEndpoint: 'api.php',
};

const PLACEHOLDER_SELECTOR = '.transcript__placeholder';
const TEST_MODE = Boolean(globalThis.__APP_TEST_MODE__);

function setStatus(message, variant = 'info') {
    dom.status.textContent = message;
    dom.status.dataset.variant = variant;
}

function setMicActive(isActive) {
    dom.micButton.setAttribute('aria-pressed', String(isActive));
    dom.micButton.classList.toggle('is-active', Boolean(isActive));
}

function bytesToBase64(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
        return '';
    }
    const chunk = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunk) {
        const slice = bytes.subarray(i, i + chunk);
        binary += String.fromCharCode(...slice);
    }
    return btoa(binary);
}

function base64ToInt16(base64) {
    if (!base64) {
        return new Int16Array();
    }
    const binary = atob(base64);
    const length = binary.length;
    const buffer = new ArrayBuffer(length);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < length; i += 1) {
        view[i] = binary.charCodeAt(i);
    }
    return new Int16Array(buffer);
}

function float32ToInt16(float32Array) {
    const buffer = new ArrayBuffer(float32Array.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < float32Array.length; i += 1) {
        const sample = Math.max(-1, Math.min(1, float32Array[i]));
        view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }
    return new Int16Array(buffer);
}

function encodePcmChunk(float32Array) {
    if (!float32Array || float32Array.length === 0) {
        return '';
    }
    const pcm = float32ToInt16(float32Array);
    return bytesToBase64(new Uint8Array(pcm.buffer));
}

function resampleToTarget(data, sourceRate, targetRate) {
    if (sourceRate === targetRate) {
        return data;
    }
    const ratio = sourceRate / targetRate;
    const newLength = Math.round(data.length / ratio);
    const result = new Float32Array(newLength);
    for (let i = 0; i < newLength; i += 1) {
        const position = i * ratio;
        const baseIndex = Math.floor(position);
        const nextIndex = Math.min(baseIndex + 1, data.length - 1);
        const weight = position - baseIndex;
        result[i] = data[baseIndex] + (data[nextIndex] - data[baseIndex]) * weight;
    }
    return result;
}

function parseSampleRate(mimeType, fallbackRate) {
    if (!mimeType) {
        return fallbackRate;
    }
    const rateMatch = /rate=([0-9]+)/i.exec(mimeType);
    if (!rateMatch) {
        return fallbackRate;
    }
    const parsed = Number(rateMatch[1]);
    return Number.isNaN(parsed) || parsed <= 0 ? fallbackRate : parsed;
}

async function requestToken() {
    const response = await fetch(config.apiEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Token request failed: ${response.status} ${text}`);
    }

    return response.json();
}

async function parseSocketPayload(event) {
    if (!event.data) {
        return null;
    }

    try {
        let raw = event.data;
        if (raw instanceof Blob) {
            raw = await raw.text();
        } else if (raw instanceof ArrayBuffer) {
            raw = new TextDecoder().decode(raw);
        } else {
            raw = String(raw);
        }
        return JSON.parse(raw);
    } catch (error) {
        console.error('Failed to parse socket payload', error);
        return null;
    }
}

class TranscriptManager {
    constructor(root) {
        this.root = root;
        this.current = { user: null, model: null };
    }

    updateUser(text) {
        if (!text) {
            return;
        }
        const entry = this.#ensureEntry('user', { replace: true });
        entry.text.textContent = text;
        this.#scrollToBottom();
    }

    commitUser() {
        this.current.user = null;
    }

    appendModel(text, { replace = false } = {}) {
        if (!text) {
            return;
        }
        const entry = this.#ensureEntry('model', { replace });
        entry.text.textContent = replace ? text : `${entry.text.textContent}${text}`;
        this.#scrollToBottom();
    }

    commitModel() {
        this.current.model = null;
    }

    reset() {
        this.current.user = null;
        this.current.model = null;
    }

    #ensureEntry(type, { replace = false } = {}) {
        if (!this.current[type] || replace) {
            this.current[type] = this.#createEntry(type);
        }
        return this.current[type];
    }

    #createEntry(type) {
        this.#removePlaceholder();
        const entry = document.createElement('article');
        entry.className = `transcript__entry transcript__entry--${type}`;

        const speaker = document.createElement('span');
        speaker.className = 'transcript__speaker';
        speaker.textContent = type === 'user' ? 'Tú' : 'Gemini';

        const text = document.createElement('p');
        text.className = 'transcript__text';
        text.textContent = '';

        entry.append(speaker, text);
        this.root.appendChild(entry);
        return { entry, text };
    }

    #removePlaceholder() {
        const placeholder = this.root.querySelector(PLACEHOLDER_SELECTOR);
        if (placeholder) {
            placeholder.remove();
        }
    }

    #scrollToBottom() {
        this.root.scrollTop = this.root.scrollHeight;
    }
}

class PlaybackQueue {
    constructor(fallbackRate) {
        this.fallbackRate = fallbackRate;
        this.context = null;
        this.queue = [];
        this.playing = false;
        this.nextStartTime = 0;
        this.startLeadTime = 0.18; // seconds of audio to pre-buffer before playback
        this.pendingSources = new Set();
        this.suppressed = false;
    }

    async enqueue(base64Data, mimeType) {
        const pcm = base64ToInt16(base64Data);
        if (!pcm.length) {
            return;
        }
        if (this.suppressed) {
            return;
        }
        const context = await this.#ensureContext();
        const sampleRate = parseSampleRate(mimeType, this.fallbackRate);
        const buffer = context.createBuffer(1, pcm.length, sampleRate);
        const channel = buffer.getChannelData(0);
        for (let i = 0; i < pcm.length; i += 1) {
            channel[i] = pcm[i] / 0x8000;
        }
        this.queue.push(buffer);
        this.#drainQueue();
    }

    async reset() {
        this.interrupt();
        this.suppressed = false;
        if (this.context) {
            try {
                await this.context.close();
            } catch (error) {
                console.warn('Failed to close playback context', error);
            }
            this.context = null;
        }
    }

    async #ensureContext() {
        if (this.context) {
            return this.context;
        }
        const context = new AudioContext();
        await context.resume();
        this.context = context;
        return this.context;
    }

    #drainQueue() {
        if (!this.context || !this.queue.length || this.suppressed) {
            if (!this.queue.length && this.pendingSources.size === 0) {
                this.playing = false;
            }
            return;
        }

        const now = this.context.currentTime;
        const leadStart = now + this.startLeadTime;
        if (this.nextStartTime < leadStart) {
            this.nextStartTime = leadStart;
        }

        while (this.queue.length) {
            const buffer = this.queue.shift();
            const source = this.context.createBufferSource();
            source.buffer = buffer;
            source.connect(this.context.destination);
            const startAt = this.nextStartTime;
            source.onended = () => {
                this.pendingSources.delete(source);
                if (!this.queue.length && this.pendingSources.size === 0) {
                    this.playing = false;
                }
            };
            try {
                source.start(startAt);
                this.playing = true;
                this.pendingSources.add(source);
                this.nextStartTime = startAt + buffer.duration;
            } catch (error) {
                console.error('Failed to start scheduled buffer', error);
            }
        }
    }

    interrupt() {
        this.queue = [];
        this.playing = false;
        this.nextStartTime = this.context ? Math.max(this.context.currentTime, 0) : 0;
        this.pendingSources.forEach((source) => {
            try {
                source.onended = null;
                source.stop();
            } catch (error) {
                console.warn('Failed to stop scheduled source', error);
            }
        });
        this.pendingSources.clear();
    }

    setSuppressed(suppressed) {
        if (this.suppressed === suppressed) {
            return;
        }
        this.suppressed = suppressed;
        if (suppressed) {
            this.interrupt();
        } else {
            this.nextStartTime = this.context ? Math.max(this.context.currentTime, 0) : 0;
            this.#drainQueue();
        }
    }
}

class VoiceSession {
    constructor({ transcript, playback }) {
        this.transcript = transcript;
        this.playback = playback;

        this.socket = null;
        this.audioContext = null;
        this.stream = null;
        this.sourceNode = null;
        this.processorNode = null;
        this.silentGain = null;

        this.active = false;
        this.closing = false;

        this.userSpeaking = false;
        this.lastSpeechAt = 0;
        this.speechThreshold = 0.017;
        this.speechHoldMs = 320;
    }

    isActive() {
        return this.active;
    }

    async start() {
        if (this.active) {
            return;
        }
        setMicActive(true);
        setStatus('Solicitando permiso de micrófono…');

        try {
            const tokenData = await requestToken();
            setStatus('Conectando con Gemini…');

            this.stream = await this.#acquireStream();
            this.audioContext = new AudioContext();
            await this.audioContext.resume();

            const accessToken = this.#resolveAccessToken(tokenData);
            const setupPayload = tokenData.setup || tokenData.config || {};
            const socketUrl = this.#buildSocketUrl(tokenData.wsUrl || config.wsEndpoint, accessToken);

            const socket = new WebSocket(socketUrl);
            socket.addEventListener('open', () => {
                this.socket = socket;
                this.active = true;
                this.closing = false;
                setStatus('Escuchando… habla cuando quieras', 'active');
                this.#sendJSON({ setup: setupPayload });
                this.#startCapture();
            });
            socket.addEventListener('message', (event) => {
                this.#handleMessage(event).catch((error) => {
                    console.error('Failed processing server message', error);
                });
            });
            socket.addEventListener('close', (event) => {
                this.#handleClose(event);
            });
            socket.addEventListener('error', (event) => {
                this.#handleError(event);
            });

            this.socket = socket;
        } catch (error) {
            console.error('No se pudo iniciar la sesión de voz', error);
            this.#failStart(error);
        }
    }

    stop() {
        if (!this.active && !this.socket) {
            return;
        }
        this.closing = true;
        setStatus('Cerrando sesión…');
        this.#cleanupAudio();
        this.#closeSocket(1000, 'mic_off');
        this.#teardown();
    }

    async #handleMessage(event) {
        const payload = await parseSocketPayload(event);
        if (!payload) {
            return;
        }

        if (payload.error) {
            console.error('Server error', payload.error);
            setStatus('Error del servidor: revisa la consola', 'error');
            return;
        }

        if (payload.reply) {
            console.log('Server reply', payload.reply);
        }

        const content = payload.serverContent;
        if (!content) {
            return;
        }

        const inputTranscription = content.inputTranscription?.text
            || content.inputTranscription?.transcript?.text;
        if (inputTranscription) {
            this.transcript.updateUser(inputTranscription);
        }

        const outputTranscription = content.outputTranscription?.text
            || content.outputTranscription?.transcript?.text;
        if (outputTranscription) {
            this.transcript.appendModel(outputTranscription, { replace: true });
        }

        const modelTurn = content.modelTurn;
        if (modelTurn?.parts) {
            for (const part of modelTurn.parts) {
                if (part.text) {
                    this.transcript.appendModel(part.text);
                }
                if (part.inlineData?.data) {
                    this.playback.enqueue(part.inlineData.data, part.inlineData.mimeType).catch((error) => {
                        console.error('Audio playback failed', error);
                    });
                }
            }
        }

        if (content.turnComplete || modelTurn?.turnComplete) {
            this.transcript.commitModel();
            setStatus('Esperando tu voz');
        }

        if (content.activityEnd) {
            this.transcript.commitUser();
        }

        if (content.event === 'model_start') {
            setStatus('Gemini está respondiendo…', 'active');
        }
    }

    #handleClose(event) {
        console.debug('Socket closed', event.code, event.reason);
        this.#cleanupAudio();
        if (!this.closing) {
            this.#teardown({ keepStatus: true });
            setStatus('Conexión finalizada');
        } else {
            this.#teardown();
        }
    }

    #handleError(event) {
        console.error('Socket error', event);
        setStatus('Fallo de conexión con Gemini', 'error');
    }

    async #acquireStream() {
        if (TEST_MODE) {
            return new MediaStream();
        }
        return navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                sampleRate: config.captureRate,
                sampleSize: 16,
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
            },
        });
    }

    #resolveAccessToken(tokenData) {
        return tokenData.token || tokenData.name || tokenData.authToken;
    }

    #buildSocketUrl(endpoint, token) {
        if (!token) {
            throw new Error('Token inválido recibido del backend');
        }
        const separator = endpoint.includes('?') ? '&' : '?';
        return `${endpoint}${separator}access_token=${encodeURIComponent(token)}`;
    }

    #startCapture() {
        if (!this.audioContext || !this.stream) {
            return;
        }

        const source = this.audioContext.createMediaStreamSource(this.stream);
        const processor = this.audioContext.createScriptProcessor(4096, 1, 1);
        const silentGain = this.audioContext.createGain();
        silentGain.gain.value = 0;

        processor.onaudioprocess = (event) => {
            if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
                return;
            }
            const input = event.inputBuffer.getChannelData(0);
            this.#handleSpeechActivity(input);
            const resampled = resampleToTarget(input, this.audioContext.sampleRate, config.captureRate);
            const base64Data = encodePcmChunk(resampled);
            if (!base64Data) {
                return;
            }
            this.#sendJSON({
                realtimeInput: {
                    audio: {
                        data: base64Data,
                        mimeType: `audio/pcm;rate=${config.captureRate}`,
                    },
                },
            });
        };

        source.connect(processor);
        processor.connect(silentGain);
        silentGain.connect(this.audioContext.destination);

        this.sourceNode = source;
        this.processorNode = processor;
        this.silentGain = silentGain;
    }

    #handleSpeechActivity(inputBuffer) {
        if (!inputBuffer || inputBuffer.length === 0) {
            return;
        }
        let sumSquares = 0;
        for (let i = 0; i < inputBuffer.length; i += 1) {
            const sample = inputBuffer[i];
            sumSquares += sample * sample;
        }
        const rms = Math.sqrt(sumSquares / inputBuffer.length);
        const now = (globalThis.performance && typeof globalThis.performance.now === 'function')
            ? globalThis.performance.now()
            : Date.now();

        if (rms >= this.speechThreshold) {
            this.lastSpeechAt = now;
            if (!this.userSpeaking) {
                this.userSpeaking = true;
                this.playback.setSuppressed(true);
            }
        } else if (this.userSpeaking && now - this.lastSpeechAt > this.speechHoldMs) {
            this.userSpeaking = false;
            this.playback.setSuppressed(false);
        }
    }

    #cleanupAudio() {
        if (this.processorNode) {
            this.processorNode.disconnect();
            this.processorNode.onaudioprocess = null;
        }
        if (this.sourceNode) {
            this.sourceNode.disconnect();
        }
        if (this.silentGain) {
            this.silentGain.disconnect();
        }
        if (this.stream) {
            this.stream.getTracks().forEach((track) => track.stop());
        }
        this.processorNode = null;
        this.sourceNode = null;
        this.silentGain = null;
        this.stream = null;

        if (this.audioContext) {
            this.audioContext.close().catch(() => {});
        }
        this.audioContext = null;

        this.userSpeaking = false;
        this.lastSpeechAt = 0;
        this.playback.setSuppressed(false);
    }

    #closeSocket(code = 1000, reason = 'user') {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            try {
                this.#sendJSON({ realtimeInput: { audioStreamEnd: true } });
            } catch (error) {
                console.warn('Failed to notify audioStreamEnd', error);
            }
        }
        if (this.socket) {
            try {
                this.socket.close(code, reason);
            } catch (error) {
                console.warn('Socket close failed', error);
            }
        }
    }

    #teardown({ keepStatus = false } = {}) {
        this.socket = null;
        this.active = false;
        this.closing = false;
        void this.playback.reset();
        this.transcript.commitModel();
        this.transcript.commitUser();
        this.transcript.reset();
        setMicActive(false);
        if (!keepStatus) {
            setStatus('Listo para escuchar');
        }
    }

    #sendJSON(payload) {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            return;
        }
        try {
            this.socket.send(JSON.stringify(payload));
        } catch (error) {
            console.error('Failed to send payload', error);
        }
    }

    #failStart(error) {
        setStatus(error?.message || 'No se pudo iniciar la sesión de voz', 'error');
        setMicActive(false);
        this.#cleanupAudio();
        this.#closeSocket();
        this.#teardown({ keepStatus: true });
    }
}

const transcript = new TranscriptManager(dom.transcript);
const playback = new PlaybackQueue(config.playbackFallbackRate);
const session = new VoiceSession({ transcript, playback });

dom.micButton.addEventListener('click', () => {
    dom.micButton.disabled = true;
    const action = session.isActive() ? Promise.resolve(session.stop()) : session.start();
    action
        .catch((error) => {
            console.error('Unexpected error handling microphone toggle', error);
        })
        .finally(() => {
            dom.micButton.disabled = false;
        });
});

if (TEST_MODE) {
    setStatus('Modo prueba: la sesión real no se inicia');
}
