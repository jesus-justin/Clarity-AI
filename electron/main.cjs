const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fsSyncfs = require('fs');
const os = require('os');
const axios = require('axios');
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

async function bufferToTempFile(buffer, mimeType) {
  const ext = mimeToExtension(mimeType);
  const tempDir = os.tmpdir();
  const tempFile = path.join(tempDir, `clarityai-${Date.now()}-${Math.random().toString(36).substr(2, 9)}.${ext}`);
  await fs.writeFile(tempFile, buffer);
  return tempFile;
}

function normalizeOutputUrls(output) {
  if (!output) {
    return [];
  }

  const values = Array.isArray(output) ? output : [output];
  return values
    .map((item) => {
      if (typeof item === 'string') {
        return item;
      }

      if (item && typeof item.url === 'function') {
        return item.url();
      }

      if (item && typeof item.url === 'string') {
        return item.url;
      }

      return String(item);
    })
    .filter(Boolean);
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

async function readApiKeyFromFile() {
  if (cachedFileApiKey !== null) {
    return cachedFileApiKey;
  }

  try {
    const keyFilePath = path.join(process.cwd(), 'api_key.txt');
    const content = await fs.readFile(keyFilePath, 'utf8');
    const match = content.match(/api_key\s*=\s*(\S+)/iu);
    const fileKey = String(match?.[1] || '').trim();
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

  if (!apiKey) {
    throw new Error('Add your Replicate API key in Settings before enhancing an image.');
  }

  const dataUrl = String(payload?.dataUrl || '');
  const fileName = String(payload?.fileName || 'enhanced-image');
  const scale = Number.isFinite(Number(payload?.scale)) ? Number(payload.scale) : 4;
  const faceEnhance = Boolean(payload?.faceEnhance);

  sendStatus(event.sender, {
    phase: 'preparing',
    progress: 8,
    message: 'Preparing the image for enhancement.'
  });

  const { buffer, mimeType } = dataUrlToBuffer(dataUrl);
  let tempFilePath = null;

  try {
    sendStatus(event.sender, {
      phase: 'uploading',
      progress: 24,
      message: 'Uploading the image to Replicate.'
    });

    tempFilePath = await bufferToTempFile(buffer, mimeType);

    const Replicate = await loadReplicateClient();
    const replicate = new Replicate({ auth: apiKey });

    sendStatus(event.sender, {
      phase: 'processing',
      progress: 45,
      message: 'AI enhancement is running.'
    });

    const output = await replicate.run(MODEL, {
      input: {
        image: tempFilePath,
        scale,
        face_enhance: faceEnhance
      }
    });

    const outputUrls = normalizeOutputUrls(output);

    if (!outputUrls.length) {
      throw new Error('Replicate returned no output image.');
    }

    sendStatus(event.sender, {
      phase: 'downloading',
      progress: 78,
      message: 'Fetching the enhanced image.'
    });

    const file = await fetchReplicateFile(apiKey, outputUrls[0]);

    sendStatus(event.sender, {
      phase: 'completed',
      progress: 100,
      message: 'Enhancement complete.'
    });

    const extension = mimeToExtension(file.mimeType);
    const baseName = path.parse(fileName).name || 'clarityai-result';

    return {
      fileName: `${baseName}-clarityai.${extension}`,
      dataUrl: bufferToDataUrl(file.buffer, file.mimeType),
      mimeType: file.mimeType
    };
  } finally {
    if (tempFilePath) {
      try {
        await fs.unlink(tempFilePath);
      } catch {
        // Ignore temp file cleanup errors
      }
    }
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