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
let cachedFileApiKey = null;

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

  if (/status code 400/iu.test(raw) || /400 Bad Request/iu.test(raw)) {
    return 'Gemini request was rejected. Check the API key permissions or model access in Google AI Studio.';
  }

  if (/status code 401/iu.test(raw) || /401 Unauthorized/iu.test(raw) || /status code 403/iu.test(raw)) {
    return 'Gemini API key is invalid or lacks permissions. Update it in Settings and retry.';
  }

  if (/status code 429/iu.test(raw)) {
    return 'Gemini rate limit reached. Wait a moment, then retry enhancement.';
  }

  return raw;
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

async function enhanceImageWithGemini(apiKey, buffer, mimeType, scale, faceEnhance) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${encodeURIComponent(apiKey)}`;
  const prompt = [
    `Enhance this photo to clear high-definition quality at about ${scale}x perceived detail improvement.`,
    'Preserve the exact person, pose, framing, and identity.',
    'Reduce blur and noise while keeping natural colors and textures.',
    faceEnhance ? 'Prioritize face clarity and natural skin detail.' : 'Do not over-smooth facial details.',
    'Return an enhanced realistic photo, no stylization, no artistic effects.'
  ].join(' ');

  const payload = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: prompt },
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
  };

  const response = await axios.post(url, payload, { timeout: 120000 });
  const parts = response?.data?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find((part) => part?.inline_data?.data || part?.inlineData?.data);

  const encoded = imagePart?.inline_data?.data || imagePart?.inlineData?.data;
  const outputMime = imagePart?.inline_data?.mime_type || imagePart?.inlineData?.mimeType || 'image/png';
  if (!encoded) {
    throw new Error('Gemini returned no image output.');
  }

  return {
    buffer: Buffer.from(encoded, 'base64'),
    mimeType: outputMime
  };
}

function clampScale(inputScale) {
  const value = Number(inputScale);
  if (!Number.isFinite(value)) {
    return 4;
  }

  return Math.max(2, Math.min(8, Math.round(value)));
}

function calculateTargetSize(width, height, scale) {
  const normalizedScale = clampScale(scale);
  const sourceWidth = Math.max(1, Number(width || 1));
  const sourceHeight = Math.max(1, Number(height || 1));

  let targetWidth = Math.round(sourceWidth * normalizedScale);
  let targetHeight = Math.round(sourceHeight * normalizedScale);

  const maxSide = 4096;
  const largestSide = Math.max(targetWidth, targetHeight);
  if (largestSide > maxSide) {
    const ratio = maxSide / largestSide;
    targetWidth = Math.max(1, Math.round(targetWidth * ratio));
    targetHeight = Math.max(1, Math.round(targetHeight * ratio));
  }

  return { targetWidth, targetHeight, normalizedScale };
}

async function preprocessInputImage(buffer, mimeType, scale) {
  const metadata = await sharp(buffer, { failOn: 'none' }).rotate().metadata();
  const { targetWidth, targetHeight } = calculateTargetSize(metadata.width, metadata.height, scale);

  // Reduce blur/noise before enhancement so cloud/local upscaling receives a cleaner signal.
  const preprocessedBuffer = await sharp(buffer, { failOn: 'none' })
    .rotate()
    .normalize()
    .sharpen({ sigma: 1.45, m1: 0.7, m2: 1.7, x1: 2, y2: 12, y3: 24 })
    .toBuffer();

  return {
    buffer: preprocessedBuffer,
    mimeType,
    targetWidth,
    targetHeight
  };
}

async function postprocessEnhancedImage(buffer, mimeType) {
  let pipeline = sharp(buffer, { failOn: 'none' })
    .rotate()
    .normalize()
    .modulate({ brightness: 1.02, saturation: 1.04 })
    .sharpen({ sigma: 1.35, m1: 0.8, m2: 1.9, x1: 2, y2: 11, y3: 22 });

  if (mimeType === 'image/jpeg') {
    return {
      buffer: await pipeline.jpeg({ quality: 96, mozjpeg: true }).toBuffer(),
      mimeType: 'image/jpeg'
    };
  }

  if (mimeType === 'image/webp') {
    return {
      buffer: await pipeline.webp({ quality: 96 }).toBuffer(),
      mimeType: 'image/webp'
    };
  }

  return {
    buffer: await pipeline.png({ quality: 96, compressionLevel: 8 }).toBuffer(),
    mimeType: 'image/png'
  };
}

async function enhanceImageLocally(buffer, mimeType, scale) {
  const source = sharp(buffer, { failOn: 'none' }).rotate();
  const metadata = await source.metadata();

  const { targetWidth, targetHeight } = calculateTargetSize(metadata.width, metadata.height, scale);

  // Two-step upscaling improves clarity on blurry faces more than a single aggressive resize.
  const intermediateWidth = Math.max(1, Math.round((metadata.width || targetWidth) * 2));
  const intermediateHeight = Math.max(1, Math.round((metadata.height || targetHeight) * 2));

  let pipeline = sharp(buffer, { failOn: 'none' })
    .rotate()
    .resize(intermediateWidth, intermediateHeight, {
      kernel: sharp.kernel.lanczos3,
      fit: 'fill'
    })
    .sharpen({ sigma: 1.55, m1: 0.8, m2: 1.8, x1: 2, y2: 12, y3: 24 })
    .normalize()
    .sharpen({ sigma: 1.3, m1: 0.65, m2: 1.5, x1: 2, y2: 10, y3: 20 });

  if (targetWidth > 0 && targetHeight > 0) {
    pipeline = pipeline.resize(targetWidth, targetHeight, {
      kernel: sharp.kernel.lanczos3,
      fit: 'fill'
    });
  }

  if (mimeType === 'image/jpeg') {
    const outputBuffer = await pipeline.jpeg({ quality: 95, mozjpeg: true }).toBuffer();
    return { buffer: outputBuffer, mimeType: 'image/jpeg' };
  }

  if (mimeType === 'image/webp') {
    const outputBuffer = await pipeline.webp({ quality: 95 }).toBuffer();
    return { buffer: outputBuffer, mimeType: 'image/webp' };
  }

  const outputBuffer = await pipeline.png({ quality: 95, compressionLevel: 8 }).toBuffer();
  return { buffer: outputBuffer, mimeType: 'image/png' };
}

async function readApiKeyFromFile() {
  if (cachedFileApiKey !== null) {
    return cachedFileApiKey;
  }

  try {
    const content = await readFirstAccessibleFile(collectCandidateKeyPaths());
    const fileKey = extractApiKey(content);
    cachedFileApiKey = fileKey;
    return fileKey;
  } catch {
    cachedFileApiKey = '';
    return '';
  }
}

async function resolveApiKey(preferredKey = '') {
  const explicitKey = String(preferredKey || '').trim();
  if (explicitKey) {
    return explicitKey;
  }

  const stored = String(store.get('apiKey', '')).trim();
  if (stored) {
    return stored;
  }

  const fromFile = await readApiKeyFromFile();
  if (fromFile) {
    store.set('apiKey', fromFile);
  }

  return fromFile;
}

ipcMain.handle('clarityai:get-settings', async () => {
  const apiKey = await resolveApiKey();
  return { apiKey };
});

ipcMain.handle('clarityai:save-settings', async (_event, payload) => {
  const apiKey = String(payload?.apiKey || '').trim();
  store.set('apiKey', apiKey);
  cachedFileApiKey = apiKey || cachedFileApiKey;
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

    const polishedFile = await postprocessEnhancedImage(file.buffer, file.mimeType);

    const extension = mimeToExtension(polishedFile.mimeType);
    const baseName = path.parse(fileName).name || 'clarityai-result';
    const outputSuffix = usedCloud ? `clarityai-${cloudProvider}` : 'clarityai-local';

    return {
      fileName: `${baseName}-${outputSuffix}.${extension}`,
      dataUrl: bufferToDataUrl(polishedFile.buffer, polishedFile.mimeType),
      mimeType: polishedFile.mimeType
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