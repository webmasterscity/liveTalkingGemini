<?php
declare(strict_types=1);

const DEFAULT_GEMINI_MODEL = 'models/gemini-2.5-flash-native-audio-preview-09-2025';
const DEFAULT_VOICE = 'Zephyr';
const TARGET_EXPIRES_SECONDS = 25 * 60; // 25 minutes
const TARGET_NEW_SESSION_WINDOW_SECONDS = 90; // 90 seconds
const WS_ENDPOINT = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const DEFAULT_RESPONSE_MODALITIES = ['AUDIO'];
const DEFAULT_CONTEXT_WINDOW = [
    'triggerTokens' => 25600,
    'slidingWindow' => ['targetTokens' => 12800],
];

header('Vary: Origin');
$origin = $_SERVER['HTTP_ORIGIN'] ?? '*';
header('Access-Control-Allow-Origin: ' . $origin);
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

header('Content-Type: application/json');

function respond(int $status, array $payload): void
{
    http_response_code($status);
    echo json_encode($payload, JSON_THROW_ON_ERROR);
    exit;
}

function resolveApiKey(): string
{
$key = trim((string) getenv('GEMINI_API_KEY') ?: (string) loadEnvValue('GEMINI_API_KEY'));
    if ($key === '') {
        respond(500, [
            'error' => 'missing_api_key',
            'message' => 'Configura la variable de entorno GEMINI_API_KEY (usa .env o variables de entorno).',
        ]);
    }
    return $key;
}

function loadEnvValue(string $name): ?string
{
    static $loaded = false;
    static $values = [];

    if (!$loaded) {
        $loaded = true;
        $path = __DIR__ . '/.env';
        if (!is_file($path)) {
            return null;
        }
        foreach (file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
            $line = trim($line);
            if ($line === '' || str_starts_with($line, '#')) {
                continue;
            }
            $parts = explode('=', $line, 2);
            if (count($parts) !== 2) {
                continue;
            }
            $values[trim($parts[0])] = trim(trim($parts[1]), "'\"");
        }
    }

    return $values[$name] ?? null;
}

function isAssoc(array $array): bool
{
    return $array !== [] && array_keys($array) !== range(0, count($array) - 1);
}

function camelize(string $value): string
{
    if (!str_contains($value, '_')) {
        return $value;
    }
    $parts = array_values(array_filter(explode('_', $value), static fn (string $chunk): bool => $chunk !== ''));
    if ($parts === []) {
        return $value;
    }
    $first = strtolower(array_shift($parts));
    $camel = $first;
    foreach ($parts as $part) {
        $camel .= ucfirst(strtolower($part));
    }
    return $camel;
}

function camelizeKeys(mixed $value): mixed
{
    if (!is_array($value)) {
        return $value;
    }
    if (!isAssoc($value)) {
        return array_map('camelizeKeys', $value);
    }
    $result = [];
    foreach ($value as $key => $item) {
        $result[is_string($key) ? camelize($key) : $key] = camelizeKeys($item);
    }
    return $result;
}

function arrayValue(array $source, array $candidates, mixed $default = null): mixed
{
    foreach ($candidates as $candidate) {
        if (array_key_exists($candidate, $source)) {
            return $source[$candidate];
        }
    }
    return $default;
}

final class BidiSetupBuilder
{
    private array $body;
    private string $model;
    private string $voice;
    private ?array $setup = null;

    public function __construct(array $body)
    {
        $this->body = $body;
        $this->model = $this->resolveString(['model'], DEFAULT_GEMINI_MODEL);
        $this->voice = $this->resolveString(['voice'], DEFAULT_VOICE);
    }

    public function fullSetup(): array
    {
        return $this->setup ??= $this->buildSetup();
    }

    public function tokenSetup(): array
    {
        $setup = $this->fullSetup();
        unset($setup['generationConfig']['contextWindowCompression']);
        return $setup;
    }

    public function resolvedVoice(): string
    {
        $speechConfig = $this->fullSetup()['generationConfig']['speechConfig'] ?? [];
        $voiceConfig = $speechConfig['voiceConfig']['prebuiltVoiceConfig']['voiceName'] ?? null;
        if (is_string($voiceConfig) && trim($voiceConfig) !== '') {
            return $voiceConfig;
        }
        return $this->voice;
    }

    private function buildSetup(): array
    {
        $setup = [
            'model' => $this->model,
            'generationConfig' => [
                'responseModalities' => $this->resolveResponseModalities(),
                'mediaResolution' => $this->resolveString(['mediaResolution', 'media_resolution'], 'MEDIA_RESOLUTION_LOW'),
                'speechConfig' => $this->resolveSpeechConfig(),
            ],
            'contextWindowCompression' => $this->resolveContextWindow(),
        ];

        $this->attachIfPresent($setup, 'systemInstruction', ['systemInstruction', 'system_instruction']);
        $this->attachIfPresent($setup, 'tools', ['tools'], true);
        $this->attachIfPresent($setup, 'proactivity', ['proactivity'], true);

        return $setup;
    }

    private function resolveResponseModalities(): array
    {
        $direct = arrayValue($this->body, ['responseModalities', 'response_modalities']);
        if (is_array($direct) && $direct !== []) {
            return $direct;
        }

        $generation = arrayValue($this->body, ['generationConfig', 'generation_config'], []);
        if (is_array($generation)) {
            $nested = arrayValue($generation, ['responseModalities', 'response_modalities']);
            if (is_array($nested) && $nested !== []) {
                return $nested;
            }
        }

        return DEFAULT_RESPONSE_MODALITIES;
    }

    private function resolveSpeechConfig(): array
    {
        $default = [
            'voiceConfig' => [
                'prebuiltVoiceConfig' => [
                    'voiceName' => $this->voice,
                ],
            ],
        ];

        $custom = arrayValue($this->body, ['speechConfig', 'speech_config']);
        if (is_array($custom) && $custom !== []) {
            return array_replace_recursive($default, camelizeKeys($custom));
        }

        return $default;
    }

    private function resolveContextWindow(): array
    {
        $custom = arrayValue($this->body, ['contextWindowCompression', 'context_window_compression']);
        if (is_array($custom) && $custom !== []) {
            return array_replace_recursive(DEFAULT_CONTEXT_WINDOW, camelizeKeys($custom));
        }
        return DEFAULT_CONTEXT_WINDOW;
    }

    private function attachIfPresent(array &$setup, string $key, array $candidates, bool $forceArray = false): void
    {
        $value = arrayValue($this->body, $candidates);
        if ($value === null) {
            return;
        }
        if ($forceArray && !is_array($value)) {
            $value = [];
        }
        $setup[$key] = camelizeKeys($value);
    }

    private function resolveString(array $candidates, string $fallback): string
    {
        $value = arrayValue($this->body, $candidates, $fallback);
        if (!is_string($value)) {
            return $fallback;
        }
        $trimmed = trim($value);
        return $trimmed !== '' ? $trimmed : $fallback;
    }
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    respond(405, [
        'error' => 'method_not_allowed',
        'message' => 'Use POST to request an ephemeral token.',
    ]);
}

$raw = file_get_contents('php://input');
$body = [];
if ($raw !== '' && $raw !== false) {
    try {
        $body = json_decode($raw, true, flags: JSON_THROW_ON_ERROR);
        if (!is_array($body)) {
            throw new RuntimeException('Body must decode to array');
        }
    } catch (Throwable) {
        respond(400, [
            'error' => 'invalid_json',
            'message' => 'Request payload must be valid JSON object.',
        ]);
    }
}

$apiKey = resolveApiKey();
if ($apiKey === '') {
    respond(500, [
        'error' => 'missing_api_key',
        'message' => 'GEMINI_API_KEY is not configured.',
    ]);
}

$builder = new BidiSetupBuilder($body);
$fullSetup = $builder->fullSetup();
$requestSetup = $builder->tokenSetup();
$voiceName = $builder->resolvedVoice();

$tokenEndpoint = 'https://generativelanguage.googleapis.com/v1alpha/auth_tokens';
$expiresAt = time() + TARGET_EXPIRES_SECONDS;
$newSessionUntil = time() + TARGET_NEW_SESSION_WINDOW_SECONDS;
$expireIso = gmdate('c', $expiresAt);
$newSessionIso = gmdate('c', $newSessionUntil);
$uses = max((int) ($body['uses'] ?? 1), 1);

$requestPayload = [
    'uses' => $uses,
    'expireTime' => $expireIso,
    'newSessionExpireTime' => $newSessionIso,
    'bidiGenerateContentSetup' => $requestSetup,
];

$curl = curl_init($tokenEndpoint);
if ($curl === false) {
    respond(500, [
        'error' => 'curl_init_failed',
        'message' => 'Failed to initialize HTTP request.',
    ]);
}

curl_setopt_array($curl, [
    CURLOPT_POST => true,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HTTPHEADER => [
        'Content-Type: application/json',
        'Accept: application/json',
        'X-Goog-Api-Key: ' . $apiKey,
    ],
    CURLOPT_POSTFIELDS => json_encode($requestPayload, JSON_THROW_ON_ERROR),
    CURLOPT_TIMEOUT => 10,
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_2TLS,
]);

$response = curl_exec($curl);
$curlInfo = curl_getinfo($curl);

if ($response === false) {
    $error = curl_error($curl);
    curl_close($curl);
    respond(502, [
        'error' => 'token_request_failed',
        'message' => 'Failed to reach Gemini token service.',
        'details' => [
            'curlError' => $error,
            'curlInfo' => $curlInfo,
        ],
    ]);
}

$status = curl_getinfo($curl, CURLINFO_RESPONSE_CODE) ?: 500;
curl_close($curl);

if (trim((string) $response) === '') {
    respond(502, [
        'error' => 'token_response_empty',
        'message' => 'Empty response from Gemini token service.',
        'details' => [
            'httpStatus' => $status,
            'curlInfo' => $curlInfo,
        ],
    ]);
}

try {
    $decoded = json_decode($response, true, flags: JSON_THROW_ON_ERROR);
} catch (Throwable) {
    respond(502, [
        'error' => 'token_response_invalid',
        'message' => 'Unexpected response from Gemini token service.',
        'details' => [
            'httpStatus' => $status,
            'curlInfo' => $curlInfo,
            'raw' => base64_encode((string) $response),
        ],
    ]);
}

if ($status >= 400) {
    respond($status, [
        'error' => 'token_service_error',
        'message' => 'Gemini token service returned an error.',
        'details' => [
            'httpStatus' => $status,
            'curlInfo' => $curlInfo,
            'response' => $decoded,
        ],
    ]);
}

$tokenName = $decoded['name'] ?? null;
if (!is_string($tokenName) || trim($tokenName) === '') {
    respond(502, [
        'error' => 'token_missing',
        'message' => 'Token service response did not include a token name.',
        'details' => $decoded,
    ]);
}

respond(200, [
    'token' => $tokenName,
    'model' => $fullSetup['model'],
    'voice' => $voiceName,
    'expiresAt' => $expireIso,
    'newSessionExpireTime' => $newSessionIso,
    'setup' => $fullSetup,
    'wsUrl' => WS_ENDPOINT . '?key=' . rawurlencode($apiKey),
]);
