# ClarityAI

ClarityAI is a local Electron + React desktop app for AI-powered photo enhancement on Windows x64.

## Features

- Drag-and-drop or click-to-upload for JPG, PNG, and WEBP images
- Replicate-powered enhancement using `nightmareai/real-esrgan`
- Side-by-side before and after preview
- Processing progress indicator and status messages
- Local download of the enhanced image
- Settings screen for storing your Replicate API key with `electron-store`

## Development

1. Install dependencies: `npm.cmd install`
2. Start the app in development: `npm.cmd run dev`

## Packaging

Build a Windows x64 zip distributable with:

```bash
npm.cmd run package
```

The packaged output is written to `release/` and produces a zip archive containing the application executable and required runtime files.

## Notes

- The Replicate API key is stored locally on the machine and never baked into the app.
- The enhancement flow uses local file handling in the Electron main process and saves the enhanced output back to the user's machine.
