const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const axios = require('axios');
const sharp = require('sharp');
const Store = require('electron-store').default;

const MODEL = 'nightmareai/real-esrgan';
const store = new Store({
  name: 'clarityai-settings',
  defaults: {
    apiKey: ''
  }
});
let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 940,
    minWidth: 1180,
    minHeight: 780,
    backgroundColor: '#0b1220',
    title: 'ClarityAI',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
  if (!app.isPackaged) {
    mainWindow.loadURL(devUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'renderer', 'index.html'));
  }
}

function sendStatus(sender, payload) {
  if (sender && !sender.isDestroyed()) {
    sender.send('clarityai:enhancement-status', payload);
  }
}

function dataUrlToBuffer(dataUrl) {
  const match = /^data:(.+?);base64,(.+)$/u.exec(dataUrl || '');
  if (!match) {
    throw new Error('Invalid image data.');
  }

  return {
    buffer: Buffer.from(match[2], 'base64'),
    mimeType: match[1]
  };
}

function mimeToExtension(mimeType) {
  switch (mimeType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'image/png':
    default:
      return 'png';
  }
}

function bufferToDataUrl(buffer, mimeType) {
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

async function normalizeOutputUrls(output) {
  if (!output) {
    return [];
  }

  const values = Array.isArray(output) ? output : [output];
  const resolved = [];

  for (const item of values) {
    if (!item) {
      continue;
    }

    if (typeof item === 'string') {
      resolved.push(item);
      continue;
    }

    if (typeof item.url === 'function') {
      const nextUrl = await item.url();
      if (nextUrl) {
        resolved.push(nextUrl);
      }
      continue;
    }

    if (typeof item.url === 'string') {
      resolved.push(item.url);
      continue;
    }

    const nextValue = String(item);
    if (nextValue && nextValue !== '[object Promise]') {
      resolved.push(nextValue);
    }
  }

  return resolved.filter(Boolean);
}

function collectCandidateKeyPaths() {
  const candidatePaths = [
    path.join(process.cwd(), 'api_key.txt'),
    path.join(path.dirname(process.execPath), 'api_key.txt')
  ];

  if (process.resourcesPath) {
    candidatePaths.push(path.join(process.resourcesPath, 'api_key.txt'));
  }

  if (app.isReady()) {
    candidatePaths.push(path.join(app.getAppPath(), 'api_key.txt'));
  }

  return [...new Set(candidatePaths)];
}

async function readFirstAccessibleFile(filePaths) {
  for (const filePath of filePaths) {
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch {
      // Try the next location.
    }
  }

  return '';
}

function extractApiKey(content) {
  const text = String(content || '').trim();
  if (!text) {
    return '';
  }

  const match = text.match(/api_key\s*=\s*(\S+)/iu);
  if (match?.[1]) {
    return String(match[1]).trim();
  }

  return text.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) || '';
}

async function fetchReplicateFile(apiKey, fileUrl) {
  const response = await axios.get(fileUrl, {
    responseType: 'arraybuffer',
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    timeout: 120000
  });

  const contentType = response.headers['content-type'] || 'image/png';
  return {
    buffer: Buffer.from(response.data),
    mimeType: contentType
  };
}

async function loadReplicateClient() {
  const mod = await import('replicate');
  return mod.default;
}

function formatReplicateErrorMessage(error) {
  const raw = error instanceof Error ? error.message : String(error || 'Enhancement failed.');

  if (/status\s+402\s+Payment Required/iu.test(raw) || /Insufficient credit/iu.test(raw)) {
    return 'Replicate account has insufficient credit. Add billing credits in Replicate, then try again.';
  }

  if (/status\s+401\s+Unauthorized/iu.test(raw)) {
    return 'Replicate API key is invalid or expired. Update it in Settings and retry.';
  }

  if (/status\s+429/iu.test(raw)) {
    return 'Replicate rate limit reached. Wait a moment, then retry enhancement.';
  }

  return raw;
}

function formatGeminiErrorMessage(error) {
  const raw = error instanceof Error ? error.message : String(error || 'Enhancement failed.');

  if (/Gemini model attempts failed\./iu.test(raw)) {
    return 'Gemini rejected all supported model endpoints for this key. Enable Gemini API and image generation access in Google AI Studio or use a key with proper permissions.';
  }

  if (/status code 400/iu.test(raw) || /400 Bad Request/iu.test(raw)) {
    return 'Gemini request was rejected. Check the API key permissions or model access in Google AI Studio.';
  }

  if (/status code 401/iu.test(raw) || /401 Unauthorized/iu.test(raw) || /status code 403/iu.test(raw)) {
    return 'Gemini API key is invalid or lacks permissions. Update it in Settings and retry.';
  }

  if (/status code 429/iu.test(raw)) {
    return 'Gemini rate limit reached. Wait a moment, then retry enhancement.';
  }

  if (/status code 503/iu.test(raw) || /503 Service Unavailable/iu.test(raw)) {
    return 'Gemini service is temporarily unavailable (503). The app retried multiple endpoints but Gemini is currently down. Please retry in a moment.';
  }

  if (/status code 500|status code 502|status code 504/iu.test(raw)) {
    return 'Gemini service had a temporary server error. Please retry in a moment.';
  }

  if (/RESOURCE_EXHAUSTED/iu.test(raw) || /quota|limit exceeded|exceeded your current quota/iu.test(raw)) {
    return 'Gemini quota limit reached for this API key/project. Increase quota or switch to a key with available quota, then retry.';
  }

  if (/status code 404/iu.test(raw) || /404 Not Found/iu.test(raw)) {
    return 'Gemini model endpoint was not found for this API key. Update the key permissions in Google AI Studio or try again with another Gemini key.';
  }

  return raw;
}

function isGeminiCompatibilityError(statusCode, error) {
  return statusCode === 400 || statusCode === 401 || statusCode === 403 || statusCode === 404 || error?.code === 'NO_IMAGE_OUTPUT';
}

function isGeminiTransientError(statusCode, error) {
  const transientStatusCodes = new Set([408, 425, 429, 500, 502, 503, 504]);
  if (transientStatusCodes.has(statusCode)) {
    return true;
  }

  const transientCodes = new Set([
    'ECONNRESET',
    'ECONNABORTED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENETUNREACH'
  ]);

  return transientCodes.has(String(error?.code || '').toUpperCase());
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function postGeminiWithRetry(url, payload, apiKey) {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await axios.post(url, payload, {
        timeout: 120000,
        headers: {
          'Content-Type': 'application/json',
          'X-goog-api-key': apiKey
        }
      });
    } catch (error) {
      const statusCode = Number(error?.response?.status || 0);
      const shouldRetry = attempt < maxAttempts && isGeminiTransientError(statusCode, error);

      if (!shouldRetry) {
        throw error;
      }

      const backoffMs = 350 * (2 ** (attempt - 1));
      await delay(backoffMs);
    }
  }

  throw new Error('Gemini request failed after retries.');
}

function detectApiProvider(apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) {
    return 'none';
  }

  if (/^r8_/iu.test(key)) {
    return 'replicate';
  }

  if (/^AIza[\w-]{20,}$/u.test(key)) {
    return 'gemini';
  }

  return 'unknown';
}

function buildRestorationPrompt(scale, faceEnhance) {
  const normalizedScale = clampScale(scale);

  return [
    'Upscale this image to the highest possible resolution supported (preferably 8K, 7680x4320, or maximum available) while strictly preserving the exact original size, framing, composition, and subject proportions.',
    'Do not crop, zoom, resize, stretch, or reframe the image in any way. Strictly maintain original distance, perspective, and subject scale.',
    'Only enhance quality by significantly improving sharpness, ultra-fine details, clarity, and focus to the highest level possible.',
    'Apply advanced AI detail enhancement to textures, eyes, skin, hair, and edges while keeping everything 100% natural and realistic.',
    'Do NOT modify, regenerate, beautify, or alter any face, body, object, or background. Preserve original identity and details exactly.',
    'Maintain original colors, lighting, shadows, and tones precisely. No artificial filters, no color shifts, no over-processing.',
    'Eliminate noise, blur, and compression artifacts cleanly without losing natural texture.',
    'Ensure ultra-sharp focus, high dynamic range clarity, and crystal-clear detail across the entire image.',
    'Final result must be identical to the original image in content and proportions, with only extreme high-quality resolution improvement, no distortion, no edits, no unnatural effects.',
    faceEnhance
      ? 'Prioritize facial restoration for eyes, skin texture, and hair detail while preserving exact identity.'
      : 'Apply uniform detail enhancement without special facial amplification.',
    `Target restoration intensity: ${normalizedScale}x perceived detail recovery.`
  ].join(' ');
}

function buildGeminiPromptVariants(basePrompt, scale, faceEnhance) {
  const normalizedScale = clampScale(scale);

  return [
    `${basePrompt} Priority mode: identity-safe restoration with natural texture preservation.`,
    `${basePrompt} Aggressive blur recovery mode: maximize edge clarity, eye detail, hair strands, skin micro-texture, and anti-compression cleanup without changing composition or identity.`,
    `${basePrompt} Precision mode: preserve original tones exactly and recover only authentic detail from blur and noise. ${faceEnhance ? 'Apply high-precision face detail restoration.' : 'Apply uniform detail restoration only.'} Scale intensity ${normalizedScale}x.`
  ];
}

async function collectScoringStats(buffer) {
  const normalized = await sharp(buffer, { failOn: 'none' })
    .rotate()
    .resize(768, 768, {
      fit: 'fill',
      kernel: sharp.kernel.lanczos3,
      withoutEnlargement: false
    })
    .toBuffer();

  const tonalStats = await sharp(normalized, { failOn: 'none' }).stats();
  const edgeStats = await sharp(normalized, { failOn: 'none' })
    .greyscale()
    .convolve({
      width: 3,
      height: 3,
      kernel: [
        0, -1, 0,
        -1, 4, -1,
        0, -1, 0
      ]
    })
    .stats();

  return {
    channels: tonalStats.channels || [],
    edgeStd: edgeStats?.channels?.[0]?.stdev || 0
  };
}

function scoreGeminiCandidate(referenceStats, candidateStats) {
  const colorChannels = Math.min(3, referenceStats.channels.length, candidateStats.channels.length);

  let colorDrift = 0;
  let textureStd = 0;
  for (let index = 0; index < colorChannels; index += 1) {
    const ref = referenceStats.channels[index];
    const cand = candidateStats.channels[index];
    colorDrift += Math.abs((cand?.mean || 0) - (ref?.mean || 0)) / 255;
    textureStd += cand?.stdev || 0;
  }

  if (colorChannels > 0) {
    textureStd /= colorChannels;
  }

  // Favor strong edge/detail recovery while penalizing color drift from the source image.
  return (candidateStats.edgeStd * 1.8) + (textureStd * 0.7) - (colorDrift * 35);
}

async function selectBestGeminiCandidate(candidates, referenceBuffer) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('No Gemini candidates available for selection.');
  }

  if (candidates.length === 1) {
    return {
      selected: candidates[0],
      selectedScore: null,
      candidateScores: [
        {
          score: null,
          model: candidates[0].model,
          endpoint: candidates[0].endpoint,
          payloadVariant: candidates[0].payloadVariant,
          promptVariant: candidates[0].promptVariant
        }
      ]
    };
  }

  const referenceStats = await collectScoringStats(referenceBuffer);
  let bestCandidate = candidates[0];
  let bestScore = Number.NEGATIVE_INFINITY;
  const candidateScores = [];

  for (const candidate of candidates) {
    const candidateStats = await collectScoringStats(candidate.buffer);
    const score = scoreGeminiCandidate(referenceStats, candidateStats);

     candidateScores.push({
      score,
      model: candidate.model,
      endpoint: candidate.endpoint,
      payloadVariant: candidate.payloadVariant,
      promptVariant: candidate.promptVariant
    });

    if (score > bestScore) {
      bestScore = score;
      bestCandidate = candidate;
    }
  }

  return {
    selected: bestCandidate,
    selectedScore: bestScore,
    candidateScores
  };
}

async function enhanceImageWithGemini(apiKey, buffer, mimeType, scale, faceEnhance) {
  const prompt = buildRestorationPrompt(scale, faceEnhance);
  const promptVariants = buildGeminiPromptVariants(prompt, scale, faceEnhance);

  const modelCandidates = [
    'gemini-2.5-flash-image',
    'gemini-3.1-flash-image-preview',
    'gemini-3-pro-image-preview',
    'gemini-flash-latest',
    'gemini-2.5-flash',
    'gemini-2.0-flash-preview-image-generation',
    'gemini-2.0-flash-exp',
    'gemini-2.0-flash',
    'gemini-2.0-flash-001',
    'gemini-2.0-flash-lite',
    'gemini-flash-lite-latest',
    'gemini-1.5-flash-latest',
    'gemini-1.5-pro-latest'
  ];

  const endpointBases = [
    'https://generativelanguage.googleapis.com/v1beta',
    'https://generativelanguage.googleapis.com/v1'
  ];

  const desiredCandidates = clampScale(scale) >= 8 ? 2 : 1;
  const successfulCandidates = [];

  let lastError = null;
  const attemptErrors = [];
  outerLoop:
  for (const variantPrompt of promptVariants) {
    for (const modelName of modelCandidates) {
      for (const endpointBase of endpointBases) {
      const payloadVariants = [
        {
          contents: [
            {
              role: 'user',
              parts: [
                { text: variantPrompt },
                {
                  inlineData: {
                    mimeType,
                    data: buffer.toString('base64')
                  }
                }
              ]
            }
          ],
          generationConfig: {
            responseModalities: ['IMAGE', 'TEXT']
          }
        },
        {
          contents: [
            {
              role: 'user',
              parts: [
                { text: `${variantPrompt} Return only the enhanced image.` },
                {
                  inlineData: {
                    mimeType,
                    data: buffer.toString('base64')
                  }
                }
              ]
            }
          ]
        },
        {
          contents: [
            {
              role: 'user',
              parts: [
                { text: `${variantPrompt} Return only the enhanced image.` },
                {
                  inline_data: {
                    mime_type: mimeType,
                    data: buffer.toString('base64')
                  }
                }
              ]
            }
          ],
          generationConfig: {
            responseModalities: ['TEXT', 'IMAGE']
          }
        }
      ];

      for (let variantIndex = 0; variantIndex < payloadVariants.length; variantIndex += 1) {
          try {
            const url = `${endpointBase}/models/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`;
            const response = await postGeminiWithRetry(url, payloadVariants[variantIndex], apiKey);
            const parts = response?.data?.candidates?.[0]?.content?.parts || [];
            const imagePart = parts.find((part) => part?.inline_data?.data || part?.inlineData?.data);
            const encoded = imagePart?.inline_data?.data || imagePart?.inlineData?.data;
            const outputMime = imagePart?.inline_data?.mime_type || imagePart?.inlineData?.mimeType || 'image/png';

            if (!encoded) {
              const noImageError = new Error(`Gemini ${modelName} ${endpointBase} variant ${variantIndex + 1} returned no image output.`);
              noImageError.code = 'NO_IMAGE_OUTPUT';
              throw noImageError;
            }

            successfulCandidates.push({
              buffer: Buffer.from(encoded, 'base64'),
              mimeType: outputMime,
              model: modelName,
              endpoint: endpointBase,
              payloadVariant: variantIndex + 1,
              promptVariant: promptVariants.indexOf(variantPrompt) + 1
            });

            if (successfulCandidates.length >= desiredCandidates) {
              break outerLoop;
            }
          } catch (error) {
            lastError = error;
            const statusCode = Number(error?.response?.status || 0);
            const detail = error?.response?.data?.error?.message || error?.message || 'Unknown error';
            attemptErrors.push(`${modelName}@${endpointBase}#${variantIndex + 1}: ${statusCode || 'no-status'} ${detail}`);

            // Continue trying other endpoint/model/payload combinations on known compatibility or transient failures.
            if (isGeminiCompatibilityError(statusCode, error) || isGeminiTransientError(statusCode, error)) {
              continue;
            }

            throw error;
          }
        }
      }
    }
  }

  if (successfulCandidates.length > 0) {
    const selection = await selectBestGeminiCandidate(successfulCandidates, buffer);
    return {
      buffer: selection.selected.buffer,
      mimeType: selection.selected.mimeType,
      meta: {
        provider: 'gemini',
        attempts: attemptErrors.length + successfulCandidates.length,
        successfulCandidates: successfulCandidates.length,
        selectedModel: selection.selected.model,
        selectedEndpoint: selection.selected.endpoint,
        selectedPayloadVariant: selection.selected.payloadVariant,
        selectedPromptVariant: selection.selected.promptVariant,
        selectedScore: selection.selectedScore,
        candidateScores: selection.candidateScores
      }
    };
  }

  if (attemptErrors.length) {
    throw new Error(`Gemini model attempts failed. ${attemptErrors.join(' | ')}`);
  }

  throw lastError || new Error('Gemini model endpoint not available for this key.');
}

function clampScale(inputScale) {
  const value = Number(inputScale);
  if (!Number.isFinite(value)) {
    return 4;
  }

  // Support up to 16x scaling for ultimate detail recovery (limited only by output size)
  return Math.max(2, Math.min(16, Math.round(value)));
}

function calculateTargetSize(width, height, scale) {
  const normalizedScale = clampScale(scale);
  const sourceWidth = Math.max(1, Number(width || 1));
  const sourceHeight = Math.max(1, Number(height || 1));

  let targetWidth = Math.round(sourceWidth * normalizedScale);
  let targetHeight = Math.round(sourceHeight * normalizedScale);

  // Allow up to 8K resolution (8192px max side) to support 8K output at 8x scale
  const maxSide = 8192;
  const largestSide = Math.max(targetWidth, targetHeight);
  if (largestSide > maxSide) {
    const ratio = maxSide / largestSide;
    targetWidth = Math.max(1, Math.round(targetWidth * ratio));
    targetHeight = Math.max(1, Math.round(targetHeight * ratio));
  }

  return { targetWidth, targetHeight, normalizedScale };
}

function getRestorationStrength(scale) {
  const normalizedScale = clampScale(scale);

  if (normalizedScale >= 16) {
    return 'extreme';
  }

  if (normalizedScale >= 8) {
    return 'high';
  }

  return 'standard';
}

function createDetailRecoveryPipeline(pipeline, targetWidth, targetHeight, scale) {
  const strength = getRestorationStrength(scale);
  const oversampleFactor = strength === 'extreme' ? 1.85 : strength === 'high' ? 1.55 : 1.25;
  const detailWidth = Math.max(1, Math.round(Number(targetWidth) * oversampleFactor));
  const detailHeight = Math.max(1, Math.round(Number(targetHeight) * oversampleFactor));

  return pipeline
    .resize(detailWidth, detailHeight, {
      kernel: sharp.kernel.lanczos3,
      fit: 'fill',
      withoutEnlargement: false
    })
    .normalize()
    .sharpen(
      strength === 'extreme'
        ? { sigma: 1.1, m1: 0.98, m2: 2.35, x1: 2, y2: 11, y3: 22 }
        : strength === 'high'
          ? { sigma: 1.2, m1: 0.96, m2: 2.25, x1: 2, y2: 11, y3: 21 }
          : { sigma: 1.3, m1: 0.94, m2: 2.15, x1: 2, y2: 12, y3: 22 }
    )
    .resize(Number(targetWidth), Number(targetHeight), {
      kernel: sharp.kernel.lanczos3,
      fit: 'fill',
      withoutEnlargement: false
    })
    .sharpen(
      strength === 'extreme'
        ? { sigma: 0.9, m1: 0.99, m2: 2.4, x1: 2, y2: 10, y3: 20 }
        : strength === 'high'
          ? { sigma: 0.95, m1: 0.98, m2: 2.3, x1: 2, y2: 10, y3: 20 }
          : { sigma: 1.0, m1: 0.97, m2: 2.2, x1: 2, y2: 10, y3: 20 }
    )
    .modulate({
      brightness: 1.0,
      saturation: 1.0,
      hue: 0
    });
}

async function preprocessInputImage(buffer, mimeType, scale) {
  const metadata = await sharp(buffer, { failOn: 'none' }).rotate().metadata();
  const { targetWidth, targetHeight } = calculateTargetSize(metadata.width, metadata.height, scale);

  // Advanced preprocessing: denoise, normalize, and sharpen for maximum detail recovery
  const preprocessedBuffer = await sharp(buffer, { failOn: 'none' })
    .rotate()
    // Normalize to optimize contrast and tonal range
    .normalize()
    // Preserve edges while reducing noise and compression artifacts.
    .median(1)
    // Aggressive detail enhancement sharpen
    .sharpen({ sigma: 1.55, m1: 0.9, m2: 2.1, x1: 3, y2: 16, y3: 30 })
    // Second pass: ultra-sharp edge recovery
    .sharpen({ sigma: 1.0, m1: 0.94, m2: 2.2, x1: 2, y2: 12, y3: 24 })
    // Modulate brightness and saturation for clarity without shifting tone
    .modulate({ brightness: 1.02, saturation: 1.01 })
    .toBuffer();

  return {
    buffer: preprocessedBuffer,
    mimeType,
    targetWidth,
    targetHeight
  };
}

async function postprocessEnhancedImage(buffer, mimeType, targetWidth, targetHeight, scale) {
  // Advanced postprocessing: multiple sharpening passes with tone optimization for maximum clarity
  const source = sharp(buffer, { failOn: 'none' }).rotate();
  const metadata = await source.metadata();

  let pipeline = source;

  if (
    Number(targetWidth) > 0 &&
    Number(targetHeight) > 0 &&
    (Number(metadata.width) !== Number(targetWidth) || Number(metadata.height) !== Number(targetHeight))
  ) {
    pipeline = pipeline.resize(Number(targetWidth), Number(targetHeight), {
      kernel: sharp.kernel.lanczos3,
      fit: 'fill',
      withoutEnlargement: false
    });
  }

  pipeline = pipeline
    .normalize()
    // First sharpening pass: detail enhancement
    .sharpen({ sigma: 1.5, m1: 0.95, m2: 2.2, x1: 3, y2: 15, y3: 28 })
    // Modulate for optimal brightness and color saturation while staying close to the original
    .modulate({ brightness: 1.0, saturation: 1.01, hue: 0 })
    // Second sharpening pass: ultra-sharp edges
    .sharpen({ sigma: 0.9, m1: 0.98, m2: 2.35, x1: 2, y2: 11, y3: 22 })
    // Final clarity enhancement
    .modulate({ brightness: 1.0, saturation: 1.0 });

  pipeline = createDetailRecoveryPipeline(pipeline, targetWidth || metadata.width || 1, targetHeight || metadata.height || 1, scale);

  if (mimeType === 'image/jpeg') {
    return {
      buffer: await pipeline.jpeg({ quality: 98, mozjpeg: true, progressive: true }).toBuffer(),
      mimeType: 'image/jpeg'
    };
  }

  if (mimeType === 'image/webp') {
    return {
      buffer: await pipeline.webp({ quality: 98, alphaQuality: 100 }).toBuffer(),
      mimeType: 'image/webp'
    };
  }

  return {
    buffer: await pipeline.png({ quality: 100, compressionLevel: 9, adaptiveFiltering: true }).toBuffer(),
    mimeType: 'image/png'
  };
}

async function enhanceImageLocally(buffer, mimeType, scale) {
  const source = sharp(buffer, { failOn: 'none' }).rotate();
  const metadata = await source.metadata();

  const { targetWidth, targetHeight } = calculateTargetSize(metadata.width, metadata.height, scale);

  // Multi-step upscaling with aggressive detail recovery
  // Step 1: Initial upscale to 2x with lanczos3 (highest quality kernel)
  const intermediateWidth = Math.max(1, Math.round((metadata.width || targetWidth) * 2));
  const intermediateHeight = Math.max(1, Math.round((metadata.height || targetHeight) * 2));

  let pipeline = sharp(buffer, { failOn: 'none' })
    .rotate()
    // Step 1: Upscale to 2x
    .resize(intermediateWidth, intermediateHeight, {
      kernel: sharp.kernel.lanczos3,
      fit: 'fill'
    })
    // Normalize after first upscale
    .normalize()
    // Ultra-aggressive sharpening after 2x upscale
    .sharpen({ sigma: 1.6, m1: 0.94, m2: 2.2, x1: 3, y2: 16, y3: 30 })
    // Second sharpening pass for edge clarity
    .sharpen({ sigma: 0.95, m1: 0.97, m2: 2.2, x1: 2, y2: 12, y3: 24 })
    // Brightness modulation for contrast enhancement
    .modulate({ brightness: 1.0, saturation: 1.01 });

  // Step 2: Second upscale to target resolution if needed
  if (targetWidth > 0 && targetHeight > 0 && (targetWidth !== intermediateWidth || targetHeight !== intermediateHeight)) {
    pipeline = pipeline
      .resize(targetWidth, targetHeight, {
        kernel: sharp.kernel.lanczos3,
        fit: 'fill'
      })
      // Final aggressive sharpening at target resolution
      .sharpen({ sigma: 1.3, m1: 0.95, m2: 2.2, x1: 3, y2: 14, y3: 26 })
      .sharpen({ sigma: 0.85, m1: 0.99, m2: 2.35, x1: 2, y2: 11, y3: 21 });
  }

  // Final modulation for maximum clarity
  pipeline = pipeline.modulate({ brightness: 1.0, saturation: 1.0 });

  if (mimeType === 'image/jpeg') {
    const outputBuffer = await pipeline.jpeg({ quality: 98, mozjpeg: true, progressive: true }).toBuffer();
    return { buffer: outputBuffer, mimeType: 'image/jpeg' };
  }

  if (mimeType === 'image/webp') {
    const outputBuffer = await pipeline.webp({ quality: 98, alphaQuality: 100 }).toBuffer();
    return { buffer: outputBuffer, mimeType: 'image/webp' };
  }

  const outputBuffer = await pipeline.png({ quality: 100, compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
  return { buffer: outputBuffer, mimeType: 'image/png' };
}

async function readApiKeyFromFile() {
  try {
    const content = await readFirstAccessibleFile(collectCandidateKeyPaths());
    return extractApiKey(content);
  } catch {
    return '';
  }
}

async function resolveApiKey(preferredKey = '') {
  const explicitKey = String(preferredKey || '').trim();
  if (explicitKey) {
    return explicitKey;
  }

  // Prefer api_key.txt for packaged workflows so key swaps work without opening Settings.
  const fromFile = await readApiKeyFromFile();
  if (fromFile) {
    store.set('apiKey', fromFile);
    return fromFile;
  }

  const stored = String(store.get('apiKey', '')).trim();
  if (stored) {
    return stored;
  }

  return '';
}

ipcMain.handle('clarityai:get-settings', async () => {
  const apiKey = await resolveApiKey();
  return { apiKey };
});

ipcMain.handle('clarityai:save-settings', async (_event, payload) => {
  const apiKey = String(payload?.apiKey || '').trim();
  store.set('apiKey', apiKey);
  return { apiKey };
});

ipcMain.handle('clarityai:enhance-image', async (event, payload) => {
  const apiKey = await resolveApiKey(payload?.apiKey);

  const dataUrl = String(payload?.dataUrl || '');
  const fileName = String(payload?.fileName || 'enhanced-image');
  const scale = clampScale(payload?.scale);
  const faceEnhance = Boolean(payload?.faceEnhance);
  const provider = detectApiProvider(apiKey);
  const usingCloud = provider === 'replicate' || provider === 'gemini';

  sendStatus(event.sender, {
    phase: 'preparing',
    progress: 8,
    message: 'Preparing the image for enhancement.'
  });

  const { buffer, mimeType } = dataUrlToBuffer(dataUrl);
  const preparedInput = await preprocessInputImage(buffer, mimeType, scale);

  try {
    let file;
    let usedCloud = false;
    let cloudProvider = 'local';
    let enhancementMeta = null;
    if (usingCloud) {
      try {
        if (provider === 'replicate') {
          sendStatus(event.sender, {
            phase: 'uploading',
            progress: 24,
            message: 'Uploading the image to Replicate.'
          });

          const Replicate = await loadReplicateClient();
          const replicate = new Replicate({ auth: apiKey, fileEncodingStrategy: 'upload' });

          sendStatus(event.sender, {
            phase: 'processing',
            progress: 45,
            message: 'Cloud AI enhancement is running (Replicate).'
          });

          const output = await replicate.run(MODEL, {
            input: {
              image: preparedInput.buffer,
              scale,
              face_enhance: faceEnhance
            }
          });

          const outputUrls = await normalizeOutputUrls(output);

          if (!outputUrls.length) {
            throw new Error('Replicate returned no output image.');
          }

          sendStatus(event.sender, {
            phase: 'downloading',
            progress: 78,
            message: 'Fetching the enhanced image.'
          });

          file = await fetchReplicateFile(apiKey, outputUrls[0]);
          usedCloud = true;
          cloudProvider = 'replicate';
        } else if (provider === 'gemini') {
          sendStatus(event.sender, {
            phase: 'uploading',
            progress: 24,
            message: 'Uploading the image to Gemini.'
          });

          sendStatus(event.sender, {
            phase: 'processing',
            progress: 45,
            message: 'Cloud AI enhancement is running (Gemini).'
          });

          file = await enhanceImageWithGemini(apiKey, preparedInput.buffer, mimeType, scale, faceEnhance);
          enhancementMeta = file?.meta || null;

          sendStatus(event.sender, {
            phase: 'downloading',
            progress: 78,
            message: 'Preparing the Gemini-enhanced image.'
          });

          usedCloud = true;
          cloudProvider = 'gemini';
        } else {
          throw new Error('Unsupported cloud key format.');
        }
      } catch (cloudError) {
        const cloudMessage = provider === 'replicate'
          ? formatReplicateErrorMessage(cloudError)
          : formatGeminiErrorMessage(cloudError);

        if (provider === 'gemini') {
          sendStatus(event.sender, {
            phase: 'idle',
            progress: 0,
            message: cloudMessage
          });

          throw new Error(cloudMessage);
        }

        sendStatus(event.sender, {
          phase: 'processing',
          progress: 42,
          message: `${cloudMessage} Switching to free local enhancement.`
        });

        file = await enhanceImageLocally(preparedInput.buffer, mimeType, scale);

        sendStatus(event.sender, {
          phase: 'downloading',
          progress: 78,
          message: 'Preparing the enhanced result.'
        });
      }
    } else {
      sendStatus(event.sender, {
        phase: 'processing',
        progress: 45,
        message: 'Running free local enhancement.'
      });

      file = await enhanceImageLocally(preparedInput.buffer, mimeType, scale);

      sendStatus(event.sender, {
        phase: 'downloading',
        progress: 78,
        message: 'Preparing the enhanced result.'
      });
    }

    sendStatus(event.sender, {
      phase: 'completed',
      progress: 100,
      message: usedCloud ? `Enhancement complete (cloud AI: ${cloudProvider}).` : 'Enhancement complete (free local mode).'
    });

    const polishedFile = await postprocessEnhancedImage(file.buffer, file.mimeType, preparedInput.targetWidth, preparedInput.targetHeight, scale);

    const extension = mimeToExtension(polishedFile.mimeType);
    const baseName = path.parse(fileName).name || 'clarityai-result';
    const outputSuffix = usedCloud ? `clarityai-${cloudProvider}` : 'clarityai-local';

    return {
      fileName: `${baseName}-${outputSuffix}.${extension}`,
      dataUrl: bufferToDataUrl(polishedFile.buffer, polishedFile.mimeType),
      mimeType: polishedFile.mimeType,
      provider: usedCloud ? cloudProvider : 'local',
      meta: enhancementMeta
    };
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error || 'Enhancement failed.');
    const message = /api\.replicate\.com\/v1/iu.test(rawMessage)
      ? formatReplicateErrorMessage(error)
      : /generativelanguage\.googleapis\.com/iu.test(rawMessage)
        ? formatGeminiErrorMessage(error)
        : rawMessage;
    sendStatus(event.sender, {
      phase: 'idle',
      progress: 0,
      message: 'Enhancement failed.'
    });
    throw new Error(message);
  }
});

ipcMain.handle('clarityai:save-image', async (_event, payload) => {
  const dataUrl = String(payload?.dataUrl || '');
  const defaultName = String(payload?.defaultName || 'clarityai-result.png');
  const { buffer, mimeType } = dataUrlToBuffer(dataUrl);
  const extension = mimeToExtension(mimeType);
  const resolvedName = defaultName.toLowerCase().endsWith(`.${extension}`)
    ? defaultName
    : `${path.parse(defaultName).name}.${extension}`;

  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Save enhanced image',
    defaultPath: resolvedName,
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (canceled || !filePath) {
    return { canceled: true };
  }

  await fs.writeFile(filePath, buffer);
  return { canceled: false, filePath };
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});