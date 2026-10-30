# Third-party component notes

JavaScript dependencies and resolved versions are recorded in `package-lock.json`; Python dependencies are pinned in `services/asr-local/requirements.txt`. Their packages retain their own upstream licenses. Dependencies and model weights are not bundled in the source release.

Speech-model manifests identify the source repository, revision, size and SHA256 hash:

- `services/asr-local/model.json`: public Paraformer and Zipformer model assets from the referenced sherpa-onnx model repositories.
- `services/asr-local/speaker-model.json`: the referenced speaker embedding model.

An explicit redistribution-license inventory for these model assets is still required before publishing a bundled distribution. A download URL or checksum is not a license statement.

OfferPaw source is covered by the root [MIT License](LICENSE). The native `InterviewAudio.podspec` also declares MIT for that local module. Existing file-level notices are preserved. The root license does not replace the licenses of third-party dependencies or optional model assets.
