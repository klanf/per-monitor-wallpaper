# Third-party notices

## Depth Anything 3 Small

The optional depth-parallax model bundled with release builds is derived from
ByteDance Seed's **Depth Anything 3 Small** checkpoint.

- Upstream source: https://github.com/ByteDance-Seed/Depth-Anything-3
- Official checkpoint: https://huggingface.co/depth-anything/DA3-SMALL
- Copyright: 2025 The Depth Anything 3 Team
- License: Apache License 2.0

The application exports only the single-view DINOv2 + DualDPT depth branch to
ONNX. Camera pose, confidence/ray, sky and Gaussian-splatting branches are not
included. The Apache 2.0 license text is distributed in
`licenses/Depth-Anything-3-LICENSE.txt`.
