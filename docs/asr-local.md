# Optional local speech recognition

The scripted demo does not need Python or speech models. Only set up ASR when testing live audio.

1. Install 64-bit Python 3.10–3.13 and Node.js 22.3+.
2. Run `npm run asr:setup` from the repository root. On Windows, an explicit Python interpreter can be supplied with `powershell -File scripts/setup-local-asr.ps1 -Python C:/path/to/python.exe`.
3. The installer creates `.cache/asr/venv`, installs the pinned Python requirements, downloads the pinned public-model assets, and verifies their SHA256 hashes. The speech manifest is about 436 MB, plus a speaker model of about 28 MB and Python dependencies. The scripts contact the package and model hosts listed in the source.
4. Set `ASR_PROVIDER=local` and `ASR_LOCAL_URL=ws://127.0.0.1:8765` in `services/server/.env`, then configure your own live answer provider and run `npm run dev`.

`npm run asr` starts only the speech service after installation. The development launcher checks for a healthy existing local ASR and starts the installed service when needed; it does not automatically install models.

The model manifests and source references are preserved in `services/asr-local/model.json` and `speaker-model.json`. No model weights or recorded audio are bundled. Review the upstream terms before redistributing these assets. Real-speech installation and inference have not been rerun for this review candidate.

The default voice path uses bilingual Paraformer for text, Zipformer for endpointing and a separate speaker embedding model. Speaker identification assumes a limited two-person scenario; short or ambiguous speech stays unconfirmed. Manual role controls are available. Local ASR avoids a per-minute cloud ASR bill but still consumes hardware resources; a separately configured hosted answer model may charge for usage.
