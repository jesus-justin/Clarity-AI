import React, { useEffect, useMemo, useRef, useState } from 'react';

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const initialStatus = {
  phase: 'idle',
  progress: 0,
  message: 'Ready to enhance a photo.'
};

function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.15 7.15 0 0 0-1.63-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.58.23-1.12.54-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.7 8.84a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94L2.82 14.52a.5.5 0 0 0-.12.64l1.92 3.32c.13.23.39.32.6.22l2.39-.96c.5.39 1.04.71 1.63.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54c.58-.23 1.12-.54 1.63-.94l2.39.96c.22.09.47 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z"
      />
    </svg>
  );
}

function ProgressBar({ progress, message }) {
  return (
    <div className="progress-shell" aria-live="polite">
      <div className="progress-label-row">
        <span>{message}</span>
        <span>{Math.round(progress)}%</span>
      </div>
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${progress}%` }} />
      </div>
    </div>
  );
}

function PreviewCard({ title, subtitle, src, emptyText, tone = 'neutral' }) {
  return (
    <section className={`preview-card ${tone}`}>
      <div className="preview-card-header">
        <div>
          <h3>{title}</h3>
          <p>{subtitle}</p>
        </div>
      </div>
      <div className="preview-frame">
        {src ? (
          <img src={src} alt={title} />
        ) : (
          <div className="preview-empty">{emptyText}</div>
        )}
      </div>
    </section>
  );
}

function App() {
  const fileInputRef = useRef(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [savedApiKey, setSavedApiKey] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const [resultImage, setResultImage] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(initialStatus);
  const [scale, setScale] = useState(4);
  const [faceEnhance, setFaceEnhance] = useState(true);

  const hasApiKey = Boolean(savedApiKey.trim());
  const canEnhance = Boolean(selectedFile && !saving);
  const providerName = useMemo(() => detectProviderName(savedApiKey), [savedApiKey]);

  const statusTone = useMemo(() => {
    if (status.phase === 'completed') {
      return 'success';
    }

    if (error) {
      return 'danger';
    }

    return 'working';
  }, [error, status.phase]);

  useEffect(() => {
    let unsubscribe = null;

    async function loadSettings() {
      if (!window.clarityAI) {
        return;
      }

      const settings = await window.clarityAI.getSettings();
      const storedKey = settings?.apiKey || '';
      setApiKey(storedKey);
      setSavedApiKey(storedKey);
      unsubscribe = window.clarityAI.onEnhancementStatus((nextStatus) => {
        setStatus((current) => ({ ...current, ...nextStatus }));
      });
    }

    loadSettings();

    return () => {
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      if (selectedFile?.previewUrl) {
        URL.revokeObjectURL(selectedFile.previewUrl);
      }
    };
  }, [selectedFile]);

  async function handleFiles(files) {
    const file = files?.[0];
    if (!file) {
      return;
    }

    if (!ACCEPTED_TYPES.includes(file.type)) {
      setError('Please upload a JPG, PNG, or WEBP image.');
      return;
    }

    if (selectedFile?.previewUrl) {
      URL.revokeObjectURL(selectedFile.previewUrl);
    }

    const previewUrl = URL.createObjectURL(file);
    setSelectedFile({
      file,
      name: file.name,
      type: file.type,
      previewUrl,
      size: file.size
    });
    setResultImage(null);
    setError('');
    setStatus(initialStatus);
  }

  function handleDrop(event) {
    event.preventDefault();
    event.stopPropagation();
    handleFiles(event.dataTransfer.files);
  }

  async function handleEnhance() {
    if (!selectedFile) {
      setError('Choose an image first.');
      return;
    }

    setSaving(true);
    setError('');
    setStatus({
      phase: 'preparing',
      progress: 8,
      message: 'Preparing the image for enhancement.'
    });
    setResultImage(null);

    try {
      const dataUrl = await fileToDataUrl(selectedFile.file);
      const output = await window.clarityAI.enhanceImage({
        apiKey,
        dataUrl,
        fileName: selectedFile.name,
        mimeType: selectedFile.type,
        scale,
        faceEnhance
      });

      setResultImage(output);
      setStatus({
        phase: 'completed',
        progress: 100,
        message: 'Enhancement complete.'
      });
    } catch (enhanceError) {
      setError(formatEnhancementError(enhanceError));
      setStatus({
        phase: 'idle',
        progress: 0,
        message: 'Ready to enhance a photo.'
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleSave() {
    if (!resultImage?.dataUrl) {
      return;
    }

    try {
      const response = await window.clarityAI.saveImage({
        dataUrl: resultImage.dataUrl,
        defaultName: resultImage.fileName
      });

      if (!response?.canceled) {
        setStatus((current) => ({
          ...current,
          message: `Saved to ${response.filePath}`
        }));
      }
    } catch (saveError) {
      setError(saveError?.message || 'Unable to save the enhanced image.');
    }
  }

  async function handleSaveSettings(event) {
    event.preventDefault();

    try {
      const nextSettings = await window.clarityAI.saveSettings({ apiKey: apiKey.trim() });
      setSavedApiKey(nextSettings?.apiKey || '');
      setSettingsOpen(false);
      setError('');
    } catch (settingsError) {
      setError(settingsError?.message || 'Unable to save settings.');
    }
  }

  return (
    <div className="app-shell">
      <div className="bg-orb orb-one" />
      <div className="bg-orb orb-two" />

      <header className="topbar">
        <div>
          <p className="eyebrow">Desktop AI Photo Enhancement</p>
          <h1>ClarityAI</h1>
        </div>
        <button className="icon-button" type="button" onClick={() => setSettingsOpen(true)} aria-label="Open settings">
          <SettingsIcon />
        </button>
      </header>

      <main className="layout">
        <section className="hero-panel">
          <div
            className={`upload-zone ${selectedFile ? 'has-file' : ''}`}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(event) => event.preventDefault()}
            onDrop={handleDrop}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                fileInputRef.current?.click();
              }
            }}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              hidden
              onChange={(event) => handleFiles(event.target.files)}
            />

            {selectedFile ? (
              <div className="upload-preview">
                <img src={selectedFile.previewUrl} alt={selectedFile.name} />
                <div className="upload-preview-copy">
                  <strong>{selectedFile.name}</strong>
                  <span>{formatFileSize(selectedFile.size)}</span>
                </div>
              </div>
            ) : (
              <>
                <div className="upload-badge">Drop image here</div>
                <h2>Drag and drop, or click to upload</h2>
                <p>
                  Supported formats: JPG, PNG, and WEBP. Free local enhancement works without credits,
                  and cloud AI (Replicate or Gemini) is used automatically when a compatible API key is set.
                </p>
              </>
            )}
          </div>

          <div className="control-row">
            <button className="primary-button" type="button" onClick={handleEnhance} disabled={!canEnhance}>
              {saving ? 'Enhancing...' : 'Enhance Image'}
            </button>
            <button className="secondary-button" type="button" onClick={handleSave} disabled={!resultImage}>
              Download Result
            </button>
          </div>

          <div className="enhancement-controls">
            <label className="enhancement-control">
              Restoration strength
              <select value={scale} onChange={(event) => setScale(Number(event.target.value))} disabled={saving}>
                <option value={2}>2x - light enhancement</option>
                <option value={4}>4x - balanced HD (recommended)</option>
                <option value={6}>6x - stronger detail recovery</option>
                <option value={8}>8x - extreme blur recovery (8192px limit)</option>
                <option value={16}>16x - maximum restoration mode (8192px limit)</option>
              </select>
            </label>

            <label className="enhancement-toggle">
              <input
                type="checkbox"
                checked={faceEnhance}
                onChange={(event) => setFaceEnhance(event.target.checked)}
                disabled={saving}
              />
              <span>
                <strong>Face enhancement</strong>
                <small>Improves facial detail and clarity in portraits.</small>
              </span>
            </label>
          </div>

          <div className={`status-card ${statusTone}`}>
            <ProgressBar progress={status.progress} message={status.message} />
            {!hasApiKey ? (
              <p className="status-note">Free local restoration is active. Add a Replicate or Gemini API key in Settings to use cloud enhancement.</p>
            ) : null}
            {error ? <p className="status-error">{error}</p> : null}
          </div>
        </section>

        <section className="comparison-panel">
          <PreviewCard
            title="Before"
            subtitle="Original upload"
            src={selectedFile?.previewUrl}
            emptyText="Upload a photo to see the original image here."
          />
          <PreviewCard
            title="After"
            subtitle={hasApiKey ? `${providerName} cloud AI output` : 'Free local enhancement output'}
            src={resultImage?.dataUrl}
            emptyText="The enhanced result will appear here after processing."
            tone="accent"
          />
        </section>
      </main>

      {settingsOpen ? (
        <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}>
          <div className="settings-modal" onClick={(event) => event.stopPropagation()}>
            <div className="settings-modal-header">
              <div>
                <p className="eyebrow">Settings</p>
                <h2>Cloud API key</h2>
              </div>
              <button className="icon-button subtle" type="button" onClick={() => setSettingsOpen(false)}>
                Close
              </button>
            </div>

            <form onSubmit={handleSaveSettings} className="settings-form">
              <label>
                API key
                <input
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="r8_... or AIza..."
                  autoComplete="off"
                />
              </label>
              <p className="settings-help">
                Your key is stored locally with electron-store and only used for cloud enhancement from this machine.
              </p>
              <div className="settings-actions">
                <button className="secondary-button" type="button" onClick={() => setSettingsOpen(false)}>
                  Cancel
                </button>
                <button className="primary-button" type="submit">
                  Save Key
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Unable to read the selected image.'));
    reader.readAsDataURL(file);
  });
}

function formatFileSize(bytes) {
  if (!bytes) {
    return '0 KB';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
}

function formatEnhancementError(error) {
  const raw = String(error?.message || error || 'Enhancement failed.');
  return raw.replace(/^Error invoking remote method 'clarityai:enhance-image':\s*/u, '').trim();
}

function detectProviderName(apiKey) {
  const value = String(apiKey || '').trim();
  if (/^r8_/iu.test(value)) {
    return 'Replicate';
  }

  if (/^AIza[\w-]{20,}$/u.test(value)) {
    return 'Gemini';
  }

  return 'Cloud';
}

export default App;